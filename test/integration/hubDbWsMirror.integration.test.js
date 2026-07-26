/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * Integration: distributed Hub-DB WS mirror (HubDbBroadcaster <-> HubDbSync)
 *
 * Proves the cross-host hub-DB replication channel LIVE end-to-end, not just via
 * the per-side unit tests. Wires the REAL hub-side broadcaster and the REAL
 * indexer-side sync client across a REAL WebSocket + REST, between two real
 * (disposable) MariaDB databases:
 *
 *   SRC  ("hub DB")     -- HubDbBroadcaster (WS push) -+
 *        |  REST /hub-db/snapshot/<table>              +-> HubDbSync -> REP ("indexer hub-mirror DB")
 *        +- (ws server /hub-db/subscribe) -------------+
 *
 * Coverage:
 *   1. BOOTSTRAP: rows present in SRC before the indexer starts are pulled via the
 *      REST snapshot endpoint on HubDbSync.start().
 *   2. SUBSCRIBE: start() registers a live subscriber on the broadcaster.
 *   3. LIVE STREAM: a row inserted into SRC + broadcast after start arrives over the
 *      WebSocket and is applied to REP (price_snapshots).
 *   4. CROSS-CHAIN: the same live channel carries cross_chain_matches +
 *      capability_snapshots (the cross-chain DEX settlement mirror).
 *
 * Real schemas are loaded from the shipped .sql files (hub + indexer). Self-provisions
 * a throwaway MariaDB via startDisposableHubDb (or reuses HUB_DB_* env). Node 22.
 ********************************************************************/
'use strict';
const assert  = require('assert');
const http    = require('http');
const urlMod  = require('url');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');
const { WebSocketServer } = require('ws');

const HubDbBroadcaster = require('../../../xchain-hub/src/HubDbBroadcaster');
const HubDbSync        = require('../../../xchain-indexer/src/hub_db_sync');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');

const SQL = {
    price_snapshots:      '../../../xchain-hub/src/sql/price_snapshots.sql',
    oracle_prices:        '../../../xchain-hub/src/sql/oracle_prices.sql',
    cross_chain_calls:    '../../../xchain-indexer/src/sql/cross_chain_calls.sql',
    cross_chain_matches:  '../../../xchain-indexer/src/sql/cross_chain_matches.sql',
    capability_snapshots: '../../../xchain-indexer/src/sql/capability_snapshots.sql',
};

// Read a shipped DDL file and reduce it to its bare CREATE TABLE statement:
// strip the /* license */ block + `--` line comments so the driver gets one statement.
// Inline `--` comments are stripped too (not just full-line ones): a comment may carry
// a ';' (e.g. "bumped each rollback; a retraction deletes ..."), which would otherwise
// split the CREATE TABLE mid-statement on the `;` below. Mirrors the hub's own
// stripSqlLineComments in db.js. The shipped DDL has no `--` inside string literals.
function readDDL(rel) {
    let sql = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    sql = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n\r]*/g, '');
    return sql.trim().replace(/;\s*$/, '');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000, stepMs = 150) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (await fn()) return true; await sleep(stepMs); }
    return false;
}
const count = (pool, table, where = '1') => pool.query('SELECT COUNT(*) c FROM ' + table + ' WHERE ' + where).then(r => Number(r[0].c)).catch(() => 0);

describe('Hub-DB WS mirror: live broadcaster <-> sync (distributed) @integration', function () {
    // 300s: the disposable MariaDB alone takes ~40s on a loaded host (tmpfs
    // datadir; was 60s+ on disk) before the broadcaster<->sync bootstrap runs.
    this.timeout(300000);
    const SRC = 'HubWsMirror_src', REP = 'HubWsMirror_replica';
    let db, srcPool, repPool, server, wss, broadcaster, sync, port;

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping hub-DB WS mirror: no env DB and Docker unavailable'); this.skip(); }
        const base = { host: db.host, port: Number(db.port), user: db.user, password: db.pass, bigIntAsNumber: true, connectionLimit: 4 };
        const admin = mariadb.createPool(base);
        for (const d of [SRC, REP]) { await admin.query('DROP DATABASE IF EXISTS ' + d); await admin.query('CREATE DATABASE ' + d); }
        await admin.end();
        srcPool = mariadb.createPool({ ...base, database: SRC });
        repPool = mariadb.createPool({ ...base, database: REP });
        // Some shipped DDLs (cross_chain_calls) carry separate CREATE INDEX statements after the
        // CREATE TABLE; the pools don't enable multipleStatements, so split and run each in order.
        for (const t of Object.keys(SQL)) {
            const stmts = readDDL(SQL[t]).split(';').map(s => s.trim()).filter(Boolean);
            for (const s of stmts) { await srcPool.query(s); await repPool.query(s); }
        }

        // Pre-existing rows must arrive via REST snapshot (not WS) on HubDbSync.start().
        await srcPool.query(
            "INSERT INTO price_snapshots (id,round_number,coin_pair,price,reference_block,validator_count,consensus_proof,status) " +
            "VALUES (1,100,'BTC/USD','61000.00000000',100,4,'proof-boot','finalized')");
        await srcPool.query(
            "INSERT INTO capability_snapshots (id,snapshot_block,capability,signing_pubkey,amount) VALUES (1,100,'cross_chain','" + 'a'.repeat(64) + "','6000')");

        broadcaster = new HubDbBroadcaster({}, { doQuery: (sql, p) => srcPool.query(sql, p) });

        // Minimal hub HTTP surface: mirrors xchain-hub api.js REST snapshot + WS subscribe.
        server = http.createServer(async (req, res) => {
            const u = urlMod.parse(req.url, true);
            const m = u.pathname.match(/^\/hub-db\/snapshot\/([a-z_]+)$/);
            if (m) {
                try {
                    const rows = await srcPool.query('SELECT * FROM ' + m[1] + ' WHERE id > ? ORDER BY id ASC LIMIT ?',
                        [Number(u.query.since_id || 0), Number(u.query.limit || 10000)]);
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ table: m[1], rows, count: rows.length }));
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
                return;
            }
            res.writeHead(404); res.end();
        });
        wss = new WebSocketServer({ server, path: '/hub-db/subscribe' });
        wss.on('connection', ws => broadcaster.addSubscriber(ws));
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        port = server.address().port;

        sync = new HubDbSync({ doQuery: (sql, p) => repPool.query(sql, p) }, { hubUrl: 'http://127.0.0.1:' + port });
        assert.strictEqual(sync.enabled, true, 'sync must be enabled (hubUrl + hubDb present)');
        await sync.start();
        await sleep(300); // let the WS subscriber finish registering
    });

    after(async function () {
        try { if (sync) sync.stop(); } catch (_) {}
        try { if (wss) wss.close(); } catch (_) {}
        try { if (server) await new Promise(r => server.close(r)); } catch (_) {}
        try { if (srcPool) await srcPool.end(); } catch (_) {}
        try { if (repPool) await repPool.end(); } catch (_) {}
        try {
            const a = mariadb.createPool({ host: db.host, port: Number(db.port), user: db.user, password: db.pass });
            for (const d of [SRC, REP]) await a.query('DROP DATABASE IF EXISTS ' + d);
            await a.end();
        } catch (_) {}
        try { if (db) await db.stop(); } catch (_) {}
    });

    it('BOOTSTRAP: pulls pre-existing SRC rows into REP via the REST snapshot', async function () {
        assert.strictEqual(await count(repPool, 'price_snapshots', 'id=1'), 1, 'price_snapshots bootstrap row missing');
        // Keyed on the NATURAL key, never on id: _applyRow strips id for
        // capability_snapshots so local AUTO_INCREMENT assigns it (#2270, the hub's
        // ids are hub-local and a wire id can collide with a locally-assigned PK).
        // Asserting id=1 here passed only by coincidence, this being the first row
        // inserted into a fresh replica, and would break the moment the fixture
        // seeded a second row or seeded them in another order.
        assert.strictEqual(await count(repPool, 'capability_snapshots',
            "snapshot_block=100 AND capability='cross_chain'"), 1, 'capability_snapshots bootstrap row missing');
        const r = await repPool.query("SELECT price FROM price_snapshots WHERE id=1");
        assert.strictEqual(r[0].price, '61000.00000000', 'bootstrapped value mismatch');
    });

    it('SUBSCRIBE: start() registers a live subscriber on the broadcaster', function () {
        assert.strictEqual(broadcaster.getSubscriberCount(), 1, 'expected exactly one live WS subscriber');
    });

    it('LIVE STREAM: a row inserted + broadcast after start arrives over the WS (price_snapshots)', async function () {
        const row = { id: 2, round_number: 101, coin_pair: 'LTC/USD', price: '76.00000000', reference_block: 101,
            validator_count: 4, consensus_proof: 'proof-live', status: 'finalized' };
        await srcPool.query(
            "INSERT INTO price_snapshots (id,round_number,coin_pair,price,reference_block,validator_count,consensus_proof,status) VALUES (?,?,?,?,?,?,?,?)",
            [row.id, row.round_number, row.coin_pair, row.price, row.reference_block, row.validator_count, row.consensus_proof, row.status]);
        broadcaster.broadcastRow({ table: 'price_snapshots', row });
        const ok = await waitFor(async () => (await count(repPool, 'price_snapshots', 'id=2')) === 1);
        assert.ok(ok, 'live price_snapshots row never arrived over the WS');
        const r = await repPool.query("SELECT coin_pair,price FROM price_snapshots WHERE id=2");
        assert.strictEqual(r[0].coin_pair, 'LTC/USD');
        assert.strictEqual(r[0].price, '76.00000000');
    });

    it('LIVE STREAM: the same channel carries cross_chain_matches + capability_snapshots', async function () {
        const match = { id: 50, match_id: 'wsmirror-match-1', snapshot_block: 100, network: 'regtest',
            a_chain: 'BTC', a_action_index: 7, a_kind: 'order', a_tick: 'WSA', a_amount: '40', a_filled_before: '0', a_ownership: 0, a_payout_addr: 'addrA',
            b_chain: 'LTC', b_action_index: 9, b_kind: 'order', b_tick: 'WSB', b_amount: '40', b_filled_before: '0', b_ownership: 0, b_payout_addr: 'addrB',
            effective_time: 1700000000, validator_signatures: '[]', status: 'finalized' };
        await srcPool.query('INSERT INTO cross_chain_matches (' + Object.keys(match).join(',') + ') VALUES (' + Object.keys(match).map(() => '?').join(',') + ')', Object.values(match));
        broadcaster.broadcastRow({ table: 'cross_chain_matches', row: match });

        const cap = { id: 50, snapshot_block: 200, capability: 'cross_chain', signing_pubkey: 'b'.repeat(64), amount: '6000' };
        await srcPool.query('INSERT INTO capability_snapshots (id,snapshot_block,capability,signing_pubkey,amount) VALUES (?,?,?,?,?)', Object.values(cap));
        broadcaster.broadcastRow({ table: 'capability_snapshots', row: cap });

        assert.ok(await waitFor(async () => (await count(repPool, 'cross_chain_matches', "match_id='wsmirror-match-1'")) === 1),
            'live cross_chain_matches row never arrived');
        // Natural key again, for the reason given on the bootstrap case. This
        // assertion read id=50 and had been RED since xchain-indexer 521edf2
        // (2026-07-16) made capability_snapshots a natural-key mirror: the wire id
        // is dropped, so the row arrives correctly and under a different id, and
        // the test reported a mirror hole that was not there. It went unnoticed
        // because test:integration:live is not part of the `ci` script.
        assert.ok(await waitFor(async () => (await count(repPool, 'capability_snapshots',
            "snapshot_block=200 AND capability='cross_chain'")) === 1),
            'live capability_snapshots row never arrived');
    });

    it('IDEMPOTENT: a re-broadcast of an already-applied row is a no-op (INSERT IGNORE)', async function () {
        const row = { id: 2, round_number: 101, coin_pair: 'LTC/USD', price: '76.00000000', reference_block: 101,
            validator_count: 4, consensus_proof: 'proof-live', status: 'finalized' };
        broadcaster.broadcastRow({ table: 'price_snapshots', row });
        await sleep(400);
        assert.strictEqual(await count(repPool, 'price_snapshots', 'id=2'), 1, 're-broadcast must not duplicate');
    });

    // A DEFERRED retraction (hub-blip path) replays a CLOSED range [from,last]. If the new
    // canonical chain re-published a row at A' > last before the deferred drain fires, the bounded
    // delete must NOT wipe it (item 5296). Proven end-to-end over the real WS mirror.
    it('CLOSED-RANGE RETRACTION: a bounded retraction over the WS leaves a re-published row above the ceiling intact', async function () {
        const ins = (id, sai, round, pair) => srcPool.query(
            "INSERT INTO price_snapshots (id,round_number,coin_pair,price,reference_block,validator_count,consensus_proof,status,source_chain,source_action_index) " +
            "VALUES (?,?,?,'1.00000000',1,4,'proof-retr','finalized','BTC',?)", [id, round, pair, sai]);

        // Orphaned row inside the rolled-back range (source_action_index = 50), mirrored to REP.
        await ins(300, 50, 300, 'RETR-A/USD');
        broadcaster.broadcastRow({ table: 'price_snapshots', row: { id: 300, source_chain: 'BTC', source_action_index: 50 } });
        assert.ok(await waitFor(async () => (await count(repPool, 'price_snapshots', 'id=300')) === 1), 'orphan row never mirrored');

        // Deferred retraction drains as a CLOSED range [50,75] (hub already applied it; mirror it here).
        broadcaster.broadcastDeletion({ table: 'price_snapshots', source_chain: 'BTC', from_action_index: 50, to_action_index: 75 });
        assert.ok(await waitFor(async () => (await count(repPool, 'price_snapshots', 'id=300')) === 0), 'bounded retraction never removed the orphan on the replica');

        // The new chain re-published at A' = 80 (> 75). It must survive the bounded retraction.
        await ins(301, 80, 301, 'RETR-B/USD');
        broadcaster.broadcastRow({ table: 'price_snapshots', row: { id: 301, source_chain: 'BTC', source_action_index: 80 } });
        assert.ok(await waitFor(async () => (await count(repPool, 'price_snapshots', 'id=301')) === 1), 're-published row above the ceiling never mirrored');

        await sleep(300); // settle: confirm the bounded delete did not retroactively touch id=301
        assert.strictEqual(await count(repPool, 'price_snapshots', 'id=301'), 1, 're-published row A\'=80 must survive a [50,75] retraction');
        assert.strictEqual(await count(repPool, 'price_snapshots', 'id=300'), 0, 'orphan row in [50,75] must stay deleted');
    });

    // ── Item 5308: push-generation reorg fence over the WS mirror ────────────────
    // The HARD case the closed-range bound (5296) cannot solve: action_index RECYCLES after a
    // rollback (MAX+1 restarts at `first`), so the new canonical chain re-publishes a DISTINCT row
    // at the SAME action_index that is inside the deferred retraction's [first,last]. A range-only
    // delete wipes both the orphan AND the re-publish. The fence stamps each row with the source
    // chain's push_generation and carries the rollback's PRE-bump generation on the retraction, so
    // only rows with push_generation <= it are deleted. The re-published row (higher generation)
    // survives even at the recycled index. Each case below would FAIL on pre-fence code (the
    // re-published row would be deleted); it passes only because _applyRetraction now fences by
    // generation. Mirrors the same row:deleted{retraction_generation} the hub broadcasts live.
    const bcastWait = async (rows, table, whereSurvive) => {
        for (const r of rows) broadcaster.broadcastRow({ table, row: r });
        return waitFor(async () => (await count(repPool, table, whereSurvive)) === rows.length);
    };

    it('GEN FENCE (price_snapshots): a re-published row at a RECYCLED action_index survives a gen-fenced retraction', async function () {
        // Orphan (gen 5) and re-publish (gen 6) at the SAME source_action_index = 50. Distinct
        // round_number keeps the (round_number, coin_pair) unique key happy; only the generation
        // distinguishes stale from fresh.
        const orphan = { id: 600, round_number: 600, coin_pair: 'GENP/USD', source_chain: 'BTC', source_action_index: 50, push_generation: 5 };
        const repub  = { id: 601, round_number: 601, coin_pair: 'GENP/USD', source_chain: 'BTC', source_action_index: 50, push_generation: 6 };
        assert.ok(await bcastWait([orphan, repub], 'price_snapshots', 'id IN (600,601)'), 'recycle rows never mirrored');

        broadcaster.broadcastDeletion({ table: 'price_snapshots', source_chain: 'BTC', from_action_index: 50, to_action_index: 75, retraction_generation: 5 });
        assert.ok(await waitFor(async () => (await count(repPool, 'price_snapshots', 'id=600')) === 0), 'gen-5 orphan at recycled index never removed');
        await sleep(300);
        assert.strictEqual(await count(repPool, 'price_snapshots', 'id=601'), 1, 'gen-6 re-publish at the SAME recycled index must survive a gen-5 retraction');
        assert.strictEqual(await count(repPool, 'price_snapshots', 'id=600'), 0, 'gen-5 orphan must stay deleted');
    });

    it('GEN FENCE (oracle_prices): a higher-gen row at a recycled index survives; a stale in-range row still deletes', async function () {
        // oracle_prices carries UNIQUE (source_chain, action_index), so two rows can't share index 50;
        // the recycled-index row REPLACES the orphan. Survivor = the gen-6 row now at index 50; the
        // gen-5 orphan at index 60 (also inside [50,75]) proves deletion still fires under the fence.
        const survivor = { id: 610, source_address: 'oGenNew', source_chain: 'BTC', coin: 'BTC', tick: 'T', fiat: 'USD', value: '1', block_time: 1, effective_at: 1, action_index: 50, push_generation: 6 };
        const orphan   = { id: 611, source_address: 'oGenOld', source_chain: 'BTC', coin: 'BTC', tick: 'T', fiat: 'USD', value: '1', block_time: 1, effective_at: 1, action_index: 60, push_generation: 5 };
        assert.ok(await bcastWait([survivor, orphan], 'oracle_prices', 'id IN (610,611)'), 'oracle recycle rows never mirrored');

        broadcaster.broadcastDeletion({ table: 'oracle_prices', source_chain: 'BTC', from_action_index: 50, to_action_index: 75, retraction_generation: 5 });
        assert.ok(await waitFor(async () => (await count(repPool, 'oracle_prices', 'id=611')) === 0), 'gen-5 oracle orphan never removed');
        await sleep(300);
        assert.strictEqual(await count(repPool, 'oracle_prices', 'id=610'), 1, 'gen-6 oracle row at recycled index must survive a gen-5 retraction');
        assert.strictEqual(await count(repPool, 'oracle_prices', 'id=611'), 0, 'gen-5 oracle orphan must stay deleted');
    });

    it('GEN FENCE (cross_chain_calls, single column): a re-finalized relay row at a recycled source index survives', async function () {
        // XCALL relay rows fence on the single push_generation column (source-keyed retraction).
        // Orphan + re-finalize at the SAME source_action_index = 50, distinct call_id (unique key).
        const base = { phase: 'dispatch', snapshot_block: 100, network: 'regtest', source_chain: 'BTC', source_contract_index: 1, target_chain: 'LTC', target_contract_index: 1, method: 'm', params_json: '[]', gas_limit: 1000, cross_hops: 0, effective_time: 1, validator_signatures: '[]', status: 'finalized' };
        const orphan = { ...base, id: 620, call_id: 'gen-call-orphan', source_action_index: 50, push_generation: 5 };
        const repub  = { ...base, id: 621, call_id: 'gen-call-repub',  source_action_index: 50, push_generation: 6 };
        assert.ok(await bcastWait([orphan, repub], 'cross_chain_calls', "call_id IN ('gen-call-orphan','gen-call-repub')"), 'call recycle rows never mirrored');

        broadcaster.broadcastDeletion({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 50, to_action_index: 75, retraction_generation: 5 });
        assert.ok(await waitFor(async () => (await count(repPool, 'cross_chain_calls', "call_id='gen-call-orphan'")) === 0), 'gen-5 call orphan never removed');
        await sleep(300);
        assert.strictEqual(await count(repPool, 'cross_chain_calls', "call_id='gen-call-repub'"), 1, 'gen-6 relay row at the recycled source index must survive a gen-5 retraction');
        assert.strictEqual(await count(repPool, 'cross_chain_calls', "call_id='gen-call-orphan'"), 0, 'gen-5 call orphan must stay deleted');
    });

    it('GEN FENCE (cross_chain_matches, PER-LEG): the reorged leg fences by its own generation', async function () {
        // A match has two legs on different chains, each with its own a_/b_push_generation. A BTC
        // source reorg fences ONLY the a-leg (here on BTC) by a_push_generation. Orphan + re-publish
        // share a_action_index = 50 on BTC; only a_push_generation distinguishes them.
        const base = { snapshot_block: 100, network: 'regtest', a_chain: 'BTC', a_kind: 'order', a_tick: 'A', a_amount: '1', a_filled_before: '0', a_ownership: 0, a_payout_addr: 'x', b_chain: 'LTC', b_action_index: 9, b_kind: 'order', b_tick: 'B', b_amount: '1', b_filled_before: '0', b_ownership: 0, b_payout_addr: 'y', effective_time: 1, validator_signatures: '[]', status: 'finalized', b_push_generation: 0 };
        const orphan = { ...base, id: 630, match_id: 'gen-match-orphan', a_action_index: 50, a_push_generation: 5 };
        const repub  = { ...base, id: 631, match_id: 'gen-match-repub',  a_action_index: 50, a_push_generation: 6 };
        assert.ok(await bcastWait([orphan, repub], 'cross_chain_matches', "match_id IN ('gen-match-orphan','gen-match-repub')"), 'match recycle rows never mirrored');

        broadcaster.broadcastDeletion({ table: 'cross_chain_matches', source_chain: 'BTC', from_action_index: 50, to_action_index: 75, retraction_generation: 5 });
        assert.ok(await waitFor(async () => (await count(repPool, 'cross_chain_matches', "match_id='gen-match-orphan'")) === 0), 'gen-5 match orphan (a-leg) never removed');
        await sleep(300);
        assert.strictEqual(await count(repPool, 'cross_chain_matches', "match_id='gen-match-repub'"), 1, 'gen-6 a-leg match at the recycled index must survive a gen-5 retraction');
        assert.strictEqual(await count(repPool, 'cross_chain_matches', "match_id='gen-match-orphan'"), 0, 'gen-5 match orphan must stay deleted');
    });
});
