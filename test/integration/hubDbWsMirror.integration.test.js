/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * Integration — distributed Hub-DB WS mirror (HubDbBroadcaster ↔ HubDbSync)
 *
 * Proves the cross-host hub-DB replication channel LIVE end-to-end, not just via
 * the per-side unit tests. Wires the REAL hub-side broadcaster and the REAL
 * indexer-side sync client across a REAL WebSocket + REST, between two real
 * (disposable) MariaDB databases:
 *
 *   SRC  ("hub DB")     ── HubDbBroadcaster (WS push) ─┐
 *        │  REST /hub-db/snapshot/<table>              ├─→ HubDbSync ─→ REP ("indexer hub-mirror DB")
 *        └─ (ws server /hub-db/subscribe) ─────────────┘
 *
 * Coverage:
 *   1. BOOTSTRAP — rows present in SRC before the indexer starts are pulled via the
 *      REST snapshot endpoint on HubDbSync.start().
 *   2. SUBSCRIBE — start() registers a live subscriber on the broadcaster.
 *   3. LIVE STREAM — a row inserted into SRC + broadcast after start arrives over the
 *      WebSocket and is applied to REP (price_snapshots).
 *   4. CROSS-CHAIN — the same live channel carries cross_chain_matches +
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
    cross_chain_matches:  '../../../xchain-indexer/src/sql/cross_chain_matches.sql',
    capability_snapshots: '../../../xchain-indexer/src/sql/capability_snapshots.sql',
};

// Read a shipped DDL file and reduce it to its bare CREATE TABLE statement:
// strip the /* license */ block + `-- ` line comments so the driver gets one statement.
function readDDL(rel) {
    let sql = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    sql = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');
    return sql.trim().replace(/;\s*$/, '');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000, stepMs = 150) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (await fn()) return true; await sleep(stepMs); }
    return false;
}
const count = (pool, table, where = '1') => pool.query('SELECT COUNT(*) c FROM ' + table + ' WHERE ' + where).then(r => Number(r[0].c)).catch(() => 0);

describe('Hub-DB WS mirror — live broadcaster ↔ sync (distributed) @integration', function () {
    this.timeout(120000);
    const SRC = 'HubWsMirror_src', REP = 'HubWsMirror_replica';
    let db, srcPool, repPool, server, wss, broadcaster, sync, port;

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping hub-DB WS mirror — no env DB and Docker unavailable'); this.skip(); }
        const base = { host: db.host, port: Number(db.port), user: db.user, password: db.pass, bigIntAsNumber: true, connectionLimit: 4 };
        const admin = mariadb.createPool(base);
        for (const d of [SRC, REP]) { await admin.query('DROP DATABASE IF EXISTS ' + d); await admin.query('CREATE DATABASE ' + d); }
        await admin.end();
        srcPool = mariadb.createPool({ ...base, database: SRC });
        repPool = mariadb.createPool({ ...base, database: REP });
        for (const t of Object.keys(SQL)) { const ddl = readDDL(SQL[t]); await srcPool.query(ddl); await repPool.query(ddl); }

        // Seed BOOTSTRAP rows into SRC *before* the indexer starts (these must arrive via REST).
        await srcPool.query(
            "INSERT INTO price_snapshots (id,round_number,coin_pair,price,reference_block,validator_count,consensus_proof,status) " +
            "VALUES (1,100,'BTC/USD','61000.00000000',100,4,'proof-boot','finalized')");
        await srcPool.query(
            "INSERT INTO capability_snapshots (id,snapshot_block,capability,signing_pubkey,amount) VALUES (1,100,'cross_chain','" + 'a'.repeat(64) + "','6000')");

        // REAL broadcaster (reads SRC for the ready-message max_ids).
        broadcaster = new HubDbBroadcaster({}, { doQuery: (sql, p) => srcPool.query(sql, p) });

        // Minimal hub HTTP surface: REST snapshot (mirrors xchain-hub api.js:677) + WS subscribe.
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

        // REAL indexer-side sync client → REP, pointed at our hub surface.
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
        assert.strictEqual(await count(repPool, 'capability_snapshots', 'id=1'), 1, 'capability_snapshots bootstrap row missing');
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
        assert.ok(await waitFor(async () => (await count(repPool, 'capability_snapshots', 'id=50')) === 1),
            'live capability_snapshots row never arrived');
    });

    it('IDEMPOTENT: a re-broadcast of an already-applied row is a no-op (INSERT IGNORE)', async function () {
        const row = { id: 2, round_number: 101, coin_pair: 'LTC/USD', price: '76.00000000', reference_block: 101,
            validator_count: 4, consensus_proof: 'proof-live', status: 'finalized' };
        broadcaster.broadcastRow({ table: 'price_snapshots', row });
        await sleep(400);
        assert.strictEqual(await count(repPool, 'price_snapshots', 'id=2'), 1, 're-broadcast must not duplicate');
    });
});
