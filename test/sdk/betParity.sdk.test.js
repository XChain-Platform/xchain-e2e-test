/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 * XChain Platform E2E - BET TWO-NODE parity drill (spec §12 E8, second half)
 *
 * E8 asks for two things. `betReorgDrill.sdk.test.js` covers the first: one
 * node rolls back across a latch/settlement block and re-converges on itself.
 * This file covers the second, which is the one P4's verify line names:
 * "state hash equal across two nodes" over a full bet lifecycle.
 *
 * WHY A SECOND NODE IS A DIFFERENT TEST. Every other BET drill reads the node
 * that WROTE the state, so it can only prove that node is self-consistent. The
 * fork class the pass-4 review found is invisible to exactly that: the `closed`
 * latch and the terminal/settlement flips are in-place UPDATEs on rows written
 * in EARLIER blocks, so a node that mishandled one still agrees with itself. It
 * takes a second node, which never saw the first node's in-memory state and
 * arrives at each block cold, to show the state is a deterministic function of
 * the chain. That is what a real fleet does every block, and what a follower
 * halts on.
 *
 * THE VENUE. Node B is a second indexer container on the same regtest chain,
 * with its own database, provisioned by `scripts/bet-parity-node.sh up` (run on
 * the venue host). It is clone-forward, not a genesis replay: this chain's
 * history was created with every gate genesis-active, so re-indexing it from
 * block 0 mis-decodes it (drill-clone-forward-venue-recipe). Node B therefore
 * inherits a consistent snapshot of node A's database and independently indexes
 * every block from there, which covers the whole bet lifecycle this drill
 * drives. Without that container the file SKIPS, loudly, rather than passing
 * vacuously.
 *
 * WHAT IS COMPARED, AND WHY THAT SET:
 *
 *   1. ledger/actions/contract hash per block - the three CONSENSUS hashes.
 *      Two independently indexing nodes must agree on every one, on every block.
 *   2. state_hash per block - the fourth, replication-integrity hash, which is
 *      the ONLY one that can see an in-place flip (stateHash.js). This is where
 *      a dropped latch shows up at all.
 *   3. The BET state-hash CLASS ROWS themselves, read with the same keys
 *      stateHash.js hashes by (bet_feeds.closed_block / terminal_block,
 *      bets.settled_block), asserted equal across nodes AND non-empty exactly
 *      at the blocks where the flips happened. Hash equality alone would also
 *      hold if both nodes ignored betting entirely; this pins WHICH class is
 *      carrying the lifecycle.
 *   4. The settled ledger: feed row, per-bet terminal status, and balances.
 *
 * The state-hash leg does not stop at "the two hashes match". It recomputes
 * node B's committed state_hash from node B's own rows through the FOLLOWER's
 * implementation (xchain-sync's byte-aligned stateHash twin), and then
 * recomputes it a second time with the two BET keys stripped out of the
 * preimage. The first must match what node B committed; the second must NOT.
 * That is the sensitivity proof that the latch is genuinely inside the hash, so
 * a follower that silently dropped it HALTS instead of diverging quietly.
 *
 * A last comparison leg deliberately BREAKS node B (a corrupted ledger hash at
 * the latch block, inside a transaction that is rolled back) and requires the
 * same comparison to report it. A parity assertion that has never failed is
 * indistinguishable from one that cannot.
 *
 * THREE TRAPS, all paid for once already:
 *
 *   1. CONFIGURE NODE B EXACTLY LIKE NODE A. The first build launched it without
 *      HUB_API_URL, reasoning that a follower should not be able to write to the
 *      hub. But the hub is the CONFIG ORACLE: without it the indexer never gets
 *      a hub DB handle, silently falls back to its own database for oracle
 *      prices, finds none, and rejects every native-fee-priced action the source
 *      accepted. The two nodes then diverge for a reason that has nothing to do
 *      with consensus code (caught here as a real divergence on an unrelated
 *      ISSUE, "no current oracle price for BTC/USD"). See the script header.
 *   1b. AND FEED IT THE SAME ORACLE PRICES. Even with the hub reachable, this
 *      venue has no HUB_DB_NAME, so the indexer reads fee-oracle prices out of
 *      its OWN database - and the harness seeds them by writing there directly.
 *      Node B never sees those writes, and diverges on anyone else's
 *      native-fee/FIAT action. The drill mirrors the two price tables across for
 *      its duration, which is what hub_db_sync does in a real fleet
 *      (mirrorOracleTables below).
 *   2. THE VENUE OUT-MINES ITS OWN INDEXER. initialCheck sets the miner to one
 *      block per second while a near-empty block costs the indexer 1.5-3s to
 *      parse, and a second indexer doubles that. The source falls behind the
 *      chain and every submit dies on the SDK's 120s indexing wait. This file
 *      eases the cadence and levels both nodes before it starts.
 *   3. APPLY-TIME ONLY for the state-hash recompute, below.
 *
 * APPLY-TIME CONSTRAINT (the trap in this file): the state-hash preimage is
 * only reproducible at the tip. Its BET rows are selected by stamp column but
 * carry the row's CURRENT status, so once a latched feed later resolves, a
 * recompute of the latch block returns 'resolved' where the node hashed
 * 'closed'. The recompute leg therefore runs while the feed is still latched
 * and before any resolve is broadcast; do not move it later in the file.
 *
 * Run:
 *   # on the venue host, once:
 *   bash scripts/bet-parity-node.sh up
 *   # from the Mac:
 *   BET_PARITY_DB_NAME=XChain_BTC_DrillB_Indexer npm run test:sdk:bet-parity
 *
 ********************************************************************/

const { expect } = require('chai');
const path       = require('path');
const cryptoHelper = require('../cryptoHelper');
const Database   = require('../../src/db');
const { makeSdk, fundedGasAddress } = require('./sdkHelper');
const {
    MIN_REFUND_WINDOW, dbQuery, getFeed, getBets, balanceOf, amtEq, actionIndexOf,
    blockTime, jumpTo, resumeMiningAtFrozenClock, releaseClock, waitFeedStatus,
    issueWagerToken, submitBet
} = require('./betHelper');

// The follower's copy of the state-hash preimage builder. Byte-aligned twin of
// xchain-indexer/src/stateHash.js (their equality is locked by
// consensusHashConformance.test.js), so using the follower's here recomputes
// what a real replica would compute rather than re-running the source's own
// code against its own rows. Absent sibling => that leg skips, as elsewhere.
let syncBuildStateHashData, SyncUtility;
try {
    ({ buildStateHashData: syncBuildStateHashData } =
        require(path.join(__dirname, '../../../xchain-sync/src/stateHash.js')));
    SyncUtility = require(path.join(__dirname, '../../../xchain-sync/src/utility.js'));
} catch (e) { /* handled at the call site */ }

// BTC's frozen ACTIVATION_DELAY_BLOCKS (src/coins/BTC.js). Only reaches the
// staking-deactivation class of the preimage, which is empty for these blocks,
// but the recompute must still pass what the node passed.
const ACTIVATION_DELAY_BLOCKS = parseInt(process.env.E2E_ACTIVATION_DELAY_BLOCKS) || 6;

function haveConnectors() {
    return global.nodeConnector && global.regtestMinerConnector && global.indexerDatabase;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let nodeB = null;

async function bQuery(sql, params) {
    const connection = await nodeB.getConnection();
    try { return await connection.query(sql, params); }
    finally { await connection.release(); }
}

async function tipOf(q) {
    const rows = await q('SELECT MAX(block_index) AS tip FROM blocks', []);
    return rows.length && rows[0].tip != null ? Number(rows[0].tip) : -1;
}

// The four per-block hashes, resolved out of the index_transactions interning
// table. The interned ROW IDS are node-local and are deliberately not compared;
// the hash strings are the portable value.
const HASHES_SQL =
    'SELECT b.block_index, ' +
    '       t1.hash AS ledger_hash, t2.hash AS actions_hash, ' +
    '       t3.hash AS contract_hash, t4.hash AS state_hash ' +
    '  FROM blocks b ' +
    '  LEFT JOIN index_transactions t1 ON t1.id = b.ledger_hash_id ' +
    '  LEFT JOIN index_transactions t2 ON t2.id = b.actions_hash_id ' +
    '  LEFT JOIN index_transactions t3 ON t3.id = b.contract_hash_id ' +
    '  LEFT JOIN index_transactions t4 ON t4.id = b.state_hash_id ' +
    ' WHERE b.block_index BETWEEN ? AND ? ORDER BY b.block_index ASC';

async function hashesOf(q, from, to) {
    const rows = await q(HASHES_SQL, [from, to]);
    const out = new Map();
    for (const r of rows) out.set(Number(r.block_index), {
        ledger_hash:   r.ledger_hash,
        actions_hash:  r.actions_hash,
        contract_hash: r.contract_hash,
        state_hash:    r.state_hash
    });
    return out;
}

// Compare every block in [from, to] across the two nodes and return the
// divergences. A block only one node has is itself a divergence: the follower
// must reach the same height, not merely agree where it happens to have data.
// `bq` is injectable so the sensitivity leg can run the SAME comparison over a
// deliberately corrupted view of node B.
async function compareHashes(from, to, bq = bQuery) {
    const [a, b] = [await hashesOf(dbQuery, from, to), await hashesOf(bq, from, to)];
    const diffs = [];
    for (let i = from; i <= to; i++) {
        const ha = a.get(i), hb = b.get(i);
        if (!ha || !hb) { diffs.push({ block: i, field: 'presence', A: !!ha, B: !!hb }); continue; }
        for (const f of ['ledger_hash', 'actions_hash', 'contract_hash', 'state_hash'])
            if (ha[f] !== hb[f]) diffs.push({ block: i, field: f, A: ha[f], B: hb[f] });
    }
    return diffs;
}

// The BET state-hash class, read with the exact keys stateHash.js hashes by.
const FEED_CLASS_SQL =
    'SELECT f.action_index, s.status AS feed_status, f.closed_block, f.terminal_block ' +
    '  FROM bet_feeds f JOIN index_statuses s ON s.id = f.feed_status_id ' +
    ' WHERE f.closed_block BETWEEN ? AND ? OR f.terminal_block BETWEEN ? AND ? ' +
    ' ORDER BY f.action_index ASC';
const BET_CLASS_SQL =
    'SELECT b.action_index, s.status AS bet_status, b.settled_block ' +
    '  FROM bets b JOIN index_statuses s ON s.id = b.bet_status_id ' +
    ' WHERE b.settled_block BETWEEN ? AND ? ORDER BY b.action_index ASC';

async function betClasses(q, from, to) {
    const feeds = await q(FEED_CLASS_SQL, [from, to, from, to]);
    const bets  = await q(BET_CLASS_SQL,  [from, to]);
    const norm = rows => rows.map(r => Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, v == null ? null : String(v)])));
    return { feeds: norm(feeds), bets: norm(bets) };
}

// Wait for node B to reach `height`. B is a passive follower of the same chain,
// so it trails node A by however long its own block loop takes.
async function waitNodeB(height, timeoutMs = 420000) {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    while (Date.now() < deadline) {
        last = await tipOf(bQuery);
        if (last >= height) return last;
        await sleep(3000);
    }
    return last;
}

// Park the miner until BOTH indexers are level with the chain, then hand it back.
//
// Two separate lags have to be cleared, and only one of them is about node B:
//
//   * node B is clone-forward, so it starts as many blocks behind as the clone
//     took to restore, and
//   * node A is routinely behind the CHAIN on this venue regardless of betting.
//     A near-empty block costs it 1.5-3s to parse while the e2e harness sets the
//     miner to one block per SECOND (initialCheck.test.js), so any suite that
//     mines steadily outruns it. Running a second indexer roughly doubles the
//     per-block cost and pushes the lag past the SDK's 120s indexing wait, which
//     then surfaces as "Timed out waiting for transaction ... to be indexed"
//     during setup and points nowhere near the cause. Two runs of this drill
//     died that way before this helper existed.
//
// Pausing is the only reliable way to close a gap the venue is actively
// widening; it is bounded, and the miner is always resumed.
async function levelNodes(timeoutMs = 480000) {
    const miner = global.regtestMinerConnector;
    let paused = false;
    const read = async () => ({
        nodeHeight: await global.nodeConnector.getBlockCount(),
        tipA: await tipOf(dbQuery),
        tipB: await tipOf(bQuery)
    });
    try {
        const deadline = Date.now() + timeoutMs;
        let s = await read();
        // Give up early on a node that is not moving at all. A torn-down node B
        // would otherwise hold the shared miner parked for the full timeout, and
        // a dead follower is a venue problem to report, not to wait out.
        let lastB = s.tipB, movedAt = Date.now();
        while (Date.now() < deadline && (s.nodeHeight - s.tipA > 2 || s.nodeHeight - s.tipB > 2)) {
            if (!paused) { await miner.pauseMining(); paused = true; }
            await sleep(3000);
            s = await read();
            if (s.tipB > lastB) { lastB = s.tipB; movedAt = Date.now(); }
            else if (Date.now() - movedAt > 60000 && s.nodeHeight - s.tipB > 2) break;
        }
        return s;
    } finally {
        if (paused) { try { await miner.resumeMining(); } catch (e) { /* best effort */ } }
    }
}

// ── the oracle-price shim ────────────────────────────────────────────────────
// The e2e harness seeds fee-oracle prices by writing price_snapshots /
// oracle_prices STRAIGHT INTO THE INDEXER'S OWN DATABASE (this venue sets no
// HUB_DB_NAME, so the indexer's price lookup falls back to its local copy of
// what the hub would otherwise supply). Those rows are an EXTERNAL input, not
// chain data - in a real fleet hub_db_sync carries the identical rows down to
// every node. A second node that never receives them is not running the same
// inputs, and every native-fee or FIAT-priced action on the venue then diverges
// for a configuration reason rather than a consensus one: observed twice here,
// as `invalid: no current oracle price for BTC/USD` on an unrelated ISSUE and
// `invalid: ORACLE_ADDRESS (no effective oracle price)` on an unrelated
// DISPENSER, both rejected by node B alone. So the drill plays hub_db_sync.
const ORACLE_TABLES = ['price_snapshots', 'oracle_prices'];
let mirrorTimer = null;

async function mirrorOracleTables() {
    for (const table of ORACLE_TABLES) {
        let rows;
        try { rows = await dbQuery(`SELECT * FROM ${table}`, []); }
        catch (e) { continue; }                       // table absent on this schema
        if (!rows.length) continue;
        const cols = Object.keys(rows[0]);
        const place = cols.map(() => '?').join(', ');
        for (const r of rows) {
            try {
                await bQuery(`REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${place})`,
                    cols.map(c => r[c]));
            } catch (e) { /* best effort: a live writer may hold the row */ }
        }
    }
}

async function blockIndexOfAction(actionIndex) {
    const rows = await dbQuery('SELECT block_index FROM actions WHERE action_index = ?', [actionIndex]);
    return rows.length ? Number(rows[0].block_index) : null;
}

// Orphan `targetBlock` and build a longer competing chain over it (same
// mechanism as betReorgDrill; both nodes read the reorg from the shared
// decoder, so this exercises the rollback path on BOTH of them at once).
async function reorgPast(targetBlock, label) {
    const node = global.nodeConnector;
    const tipBefore = await node.getBlockCount();
    const oldHash   = await node.getBlockHash(targetBlock);
    const payout    = (await cryptoHelper.getNewAddress(label, global.COIN, global.NETWORK, null, 'legacy', 0)).address;

    await node.invalidateBlock(oldHash);
    expect(await node.getBlockCount(), 'node rolled back below the target block')
        .to.equal(targetBlock - 1);
    const need = tipBefore - (targetBlock - 1) + 2;
    for (let i = 0; i < need; i++) await node.generateBlock(payout, []);
    expect(await node.getBlockHash(targetBlock), 'the chain actually reorged').to.not.equal(oldHash);
    return oldHash;
}

describe('[sdk] BET two-node state-hash parity (§12 E8: the fleet leg)', function () {
    this.timeout(0);

    let sdk, oracle, p1, p2, tick;
    let startBlock, feedIndex, deadline, latchBlock, resolveIndex, resolveBlock, endBlock;
    // Set by the first drill. Everything after it needs a node B that is
    // actually following the chain; without this the whole file grinds through a
    // full lifecycle and several multi-minute waits before reporting the one
    // thing that was wrong, and does it against the shared venue.
    let following = false;

    before(async function () {
        if (!haveConnectors()) this.skip();
        // Empty-competing-chain reorgs are a BTC/LTC mechanism; DOGE regtest's
        // fast-chain mining model differs, as the other reorg drills note.
        if (global.COIN_CODE === 'DOGE') this.skip();
        if (!process.env.BET_PARITY_DB_NAME) {
            console.log('BET_PARITY_DB_NAME unset: no second indexer node provisioned.');
            console.log('Provision one on the venue host with scripts/bet-parity-node.sh up, then re-run.');
            this.skip();
        }

        nodeB = new Database(
            process.env.DATABASE_URL || '127.0.0.1',
            parseInt(process.env.BET_PARITY_DB_PORT || process.env.DATABASE_PORT || '3306'),
            process.env.BET_PARITY_DB_NAME,
            process.env.BET_PARITY_DB_USER || process.env.INDEXER_DB_USER,
            process.env.BET_PARITY_DB_PASS || process.env.INDEXER_DB_PASS
        );
        // Bounded: the shared Database.getConnection RETRIES forever by design,
        // so an unreachable node B would hang the suite instead of skipping it.
        const reachable = await Promise.race([
            nodeB.ping().catch(() => false),
            sleep(20000).then(() => false)
        ]);
        if (!reachable) {
            console.log(`node B database ${process.env.BET_PARITY_DB_NAME} is not reachable; skipping`);
            this.skip();
        }

        // Ease the miner off the harness's one-block-per-second cadence for the
        // duration of this file (see levelNodes above for why that cadence is
        // unsurvivable with two indexers on this venue). Both numbers matter:
        // max_time caps the idle cadence, tx_added_time caps how soon a block
        // follows a transaction, and it was the latter that kept blocks coming
        // every 1.5s through the funding burst. after() hands the miner back to
        // its defaults.
        await global.regtestMinerConnector.setMiningTime(6000, 4000);

        // Keep node B supplied with the same oracle prices the harness injects
        // into node A, for as long as this file runs. Started BEFORE anything is
        // submitted, because node B has to have the row by the time it parses
        // the block that needs it, and it parses a few seconds behind.
        await mirrorOracleTables();
        mirrorTimer = setInterval(() => { mirrorOracleTables().catch(() => {}); }, 1000);

        // Start level. Node A being behind the CHAIN when the drill opens is the
        // single most likely way this file fails for a reason that has nothing
        // to do with betting.
        const level = await levelNodes();
        if (level.nodeHeight - level.tipA > 2) {
            throw new Error(`the source indexer is ${level.nodeHeight - level.tipA} blocks behind the chain `
                + `(node ${level.nodeHeight}, indexer ${level.tipA}) and is not catching up; `
                + 'the venue cannot serve this drill until it does');
        }

        // compactAddresses off: the SDK's ^id compaction outruns the indexer's
        // wire acceptance on this stack and would invalidate the setup SENDs.
        // Same stance as every other BET suite.
        sdk = makeSdk({ compactAddresses: false });

        // All funding happens before the first clock jump (funding a new address
        // after a jump fails in the encoder).
        oracle = await fundedGasAddress(sdk, 1);
        p1     = await fundedGasAddress(sdk, 1);
        p2     = await fundedGasAddress(sdk, 1);
        tick   = await issueWagerToken(sdk, oracle, [
            [p1.address, '10.00000000'], [p2.address, '5.00000000']
        ], 1000000, 'BP2');
    });

    after(async function () {
        if (mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = null; }
        try { await global.regtestMinerConnector.resumeMining(); } catch (e) { /* best effort */ }
        await releaseClock();
        if (nodeB && nodeB.pool) { try { await nodeB.pool.end(); } catch (e) { /* best effort */ } }
    });

    it('node B is independently following the same chain', async function () {
        const { tipA, tipB } = await levelNodes();
        expect(tipB, `node B is stalled at ${tipB} while node A is at ${tipA}; `
            + 'check `docker logs xchain-bet-parity-indexer` on the venue host').to.be.at.least(tipA - 2);

        // Baseline: the two nodes already agree on the blocks BEFORE this drill
        // writes anything. Without it, a first-block mismatch later could be
        // blamed on betting when the venue was already divergent.
        const from = Math.max(0, Math.min(tipA, tipB) - 20);
        const diffs = await compareHashes(from, Math.min(tipA, tipB));
        expect(diffs, `nodes disagree BEFORE the drill starts:\n${JSON.stringify(diffs.slice(0, 5), null, 1)}`)
            .to.deep.equal([]);
        following = true;
    });

    it('a market, two bets and the deadline latch land identically on both nodes', async function () {
        if (!following) this.skip();
        startBlock = await tipOf(dbQuery);

        const now = await blockTime();
        deadline = now + 900;
        let res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
            label: 'E8 two-node parity', outcomes: ['Yes', 'No'], tick,
            fee: '1.00', deadline, refundWindow: MIN_REFUND_WINDOW, now
        }));
        expect(res.indexed.status, 'create status').to.equal('valid');
        feedIndex = actionIndexOf(res);

        res = await submitBet(sdk, p1, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount: '10.00000000' }));
        expect(res.indexed.status, 'p1 bet status').to.equal('valid');
        res = await submitBet(sdk, p2, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 1, amount: '5.00000000' }));
        expect(res.indexed.status, 'p2 bet status').to.equal('valid');

        await jumpTo(deadline + 60, 2);
        const latched = await waitFeedStatus(feedIndex, 'closed');
        expect(latched.feed_status, 'feed latched closed').to.equal('closed');
        latchBlock = Number(latched.closed_block);
        expect(latchBlock, 'latch block stamped').to.be.a('number');

        const tipA = await tipOf(dbQuery);
        const tipB = await waitNodeB(tipA);
        expect(tipB, 'node B caught up to the latch').to.be.at.least(tipA);

        const diffs = await compareHashes(startBlock, tipA);
        expect(diffs, 'node A and node B diverged over the create/bet/latch span:\n'
            + JSON.stringify(diffs.slice(0, 8), null, 1)).to.deep.equal([]);

        // Same rows, same stamps, read through the class keys the hash uses.
        const [ca, cb] = [await betClasses(dbQuery, startBlock, tipA),
                          await betClasses(bQuery,  startBlock, tipA)];
        expect(cb, 'BET state-hash class rows differ across nodes').to.deep.equal(ca);

        // The latch is IN the class at its own block, on node B, which never saw
        // node A's write. This is the row-level statement of §12 E8's "the latch
        // class is non-empty at the latch block".
        const atLatch = cb.feeds.filter(r => r.closed_block === String(latchBlock));
        expect(atLatch.map(r => r.action_index), 'node B has the latch stamped at the latch block')
            .to.include(String(feedIndex));
        expect(atLatch.find(r => r.action_index === String(feedIndex)).feed_status,
            'node B latched it CLOSED, not something else').to.equal('closed');

        // ... and in no other block of the span. A latch that also appeared
        // elsewhere would mean a re-stamp, the silent relocation E17 guards.
        const strays = cb.feeds.filter(r => r.action_index === String(feedIndex)
            && r.closed_block !== String(latchBlock));
        expect(strays, 'the feed is stamped in exactly one block').to.deep.equal([]);
    });

    it('node B\'s committed state hash is reproducible from its own rows, and the BET class is load-bearing in it',
        async function () {
        if (!following) this.skip();
        if (!syncBuildStateHashData || !SyncUtility) {
            console.log('xchain-sync sibling absent; skipping the state-hash recompute leg');
            this.skip();
        }

        // APPLY-TIME ONLY. The class rows carry their CURRENT status, so this has
        // to run while the feed is still `closed`. Once it resolves, a recompute
        // of the latch block returns 'resolved' and can never match again.
        const feed = await getFeed(feedIndex);
        expect(feed.feed_status, 'still latched (the recompute leg must precede the resolve)')
            .to.equal('closed');

        // The preimage builder needs the two reads the indexer's own db exposes:
        // doQuery, and the index_statuses lookup it resolves 'completed' through.
        const adapter = {
            doQuery: (sql, params) => bQuery(sql, params),
            getStatusId: async (status) => {
                const rows = await bQuery('SELECT id FROM index_statuses WHERE status = ? LIMIT 1', [status]);
                return rows.length ? Number(rows[0].id) : null;
            }
        };
        const util = new SyncUtility();
        const preimage = await syncBuildStateHashData(adapter, latchBlock, {
            activationDelay: ACTIVATION_DELAY_BLOCKS,
            gasTick:         undefined,          // defaults to the consensus GAS symbol
            network:         global.NETWORK,
            coin:            global.COIN_CODE
        });

        const committed = (await hashesOf(bQuery, latchBlock, latchBlock)).get(latchBlock);
        expect(committed && committed.state_hash, 'node B committed a state hash for the latch block')
            .to.be.a('string');
        expect(util.getDataHash(preimage),
            'the follower recompute must reproduce what node B committed at the latch block')
            .to.equal(committed.state_hash);

        // The BET class is genuinely present at this block...
        expect(preimage.bet_feed_status, 'bet_feed_status class present in the preimage').to.be.an('array');
        expect(preimage.bet_feed_status.map(r => String(r.action_index)),
            'the latched feed is in the hashed class').to.include(String(feedIndex));

        // ...and load-bearing in two distinct senses, because only the second
        // one rules out a class that is present but empty:
        //
        //   (a) a follower that never learned about the BET keys at all drops
        //       them from the preimage, and
        //   (b) a follower that HAS the keys but failed to apply the latch
        //       hashes them empty.
        //
        // Both must move the hash. If (b) did not, a node could silently miss
        // the latch and still agree - the fork class §8 was written against.
        const dropped = Object.assign({}, preimage);
        delete dropped.bet_feed_status;
        delete dropped.bet_status;
        expect(util.getDataHash(dropped),
            'dropping the BET keys left the state hash unchanged: the class is NOT in the preimage')
            .to.not.equal(committed.state_hash);

        const emptied = Object.assign({}, preimage, { bet_feed_status: [], bet_status: [] });
        expect(util.getDataHash(emptied),
            'an EMPTY BET class hashes the same as the real one: the latch itself is not covered')
            .to.not.equal(committed.state_hash);
    });

    it('the resolve and the settlement land identically on both nodes', async function () {
        if (!following) this.skip();
        await resumeMiningAtFrozenClock();
        const res = await submitBet(sdk, oracle, sdk.betting.resolveMarketParams({
            feedActionIndex: feedIndex, outcome: 0 }));
        expect(res.indexed.status, 'resolve status').to.equal('valid');
        resolveIndex = actionIndexOf(res);

        const settled = await waitFeedStatus(feedIndex, 'resolved');
        expect(settled.feed_status, 'market resolved on node A').to.equal('resolved');
        resolveBlock = await blockIndexOfAction(resolveIndex);

        // T = 15, W = 10, fee = floor(15 * 1/100, 8) = 0.15, pot = 14.85,
        // p1 = floor(10 * 14.85 / 10, 8) = 14.85, dust = 0.
        amtEq(await balanceOf(p1.address, tick), '14.85', 'winner payout on node A');

        endBlock = await tipOf(dbQuery);
        const tipB = await waitNodeB(endBlock);
        expect(tipB, 'node B caught up past the settlement').to.be.at.least(endBlock);

        const diffs = await compareHashes(startBlock, endBlock);
        expect(diffs, 'node A and node B diverged over the full lifecycle:\n'
            + JSON.stringify(diffs.slice(0, 8), null, 1)).to.deep.equal([]);

        const [ca, cb] = [await betClasses(dbQuery, startBlock, endBlock),
                          await betClasses(bQuery,  startBlock, endBlock)];
        expect(cb, 'BET state-hash class rows differ across nodes after settlement').to.deep.equal(ca);
        expect(cb.bets.length, 'both bets settled in the class').to.equal(2);
        expect(new Set(cb.bets.map(r => r.settled_block)).size,
            'both bets settled in the SAME block').to.equal(1);

        // The settled ledger itself, not just its hash: node B credits the same
        // winner the same amount, from rows it derived on its own.
        const bBalance = await bQuery(
            'SELECT b.amount FROM balances b ' +
            '  JOIN index_addresses ia ON ia.id = b.address_id ' +
            '  JOIN index_tickers   it ON it.id = b.tick_id ' +
            ' WHERE ia.address = ? AND it.tick = ?', [p1.address, tick]);
        amtEq(bBalance.length ? String(bBalance[0].amount) : '0', '14.85',
            'node B credits the winner identically');
        amtEq(await balanceOf(p2.address, tick), '0', 'loser keeps nothing on node A');
    });

    it('a reorg across the settlement block re-converges both nodes', async function () {
        if (!following) this.skip();
        expect(resolveBlock, 'resolve block located').to.be.a('number');

        // Pin what each node currently holds AT the doomed height. The orphaned
        // block is replaced by a different one, so both nodes must end up with a
        // different ledger hash there. Without this the drill could read the
        // pre-reorg state, find the market already 'resolved', and pass without
        // either node having rolled back anything.
        const preA = (await hashesOf(dbQuery, resolveBlock, resolveBlock)).get(resolveBlock);
        const preB = (await hashesOf(bQuery,  resolveBlock, resolveBlock)).get(resolveBlock);
        expect(preB, 'node B had indexed the block that is about to be orphaned').to.not.equal(undefined);
        expect(preB.ledger_hash, 'both nodes agreed on it beforehand').to.equal(preA.ledger_hash);

        const miner = global.regtestMinerConnector;
        await miner.pauseMining();
        try {
            await reorgPast(resolveBlock, 'bet-parity-reorg');
            // The orphaned resolve returns to the mempool; give it blocks to be
            // re-mined and both nodes room to roll back and replay.
            for (let i = 0; i < 4; i++) await global.nodeConnector.generateBlock(
                (await cryptoHelper.getNewAddress('bet-parity-reorg2', global.COIN, global.NETWORK, null, 'legacy', 0)).address, []);
            await sleep(8000);
        } finally {
            await miner.resumeMining();
        }

        // Both nodes must actually roll back and re-index the replacement block
        // at that height, not merely still be sitting on the old answer.
        const rolledBack = async (q, before) => {
            for (let i = 0; i < 60; i++) {
                const now = (await hashesOf(q, resolveBlock, resolveBlock)).get(resolveBlock);
                if (now && now.ledger_hash && now.ledger_hash !== before.ledger_hash) return now;
                await sleep(3000);
            }
            return null;
        };
        const postA = await rolledBack(dbQuery, preA);
        expect(postA, 'node A rolled back and re-indexed the orphaned height').to.not.equal(null);

        // Node A re-settles (proved on its own by betReorgDrill); here the point
        // is that node B, rolling back independently, lands on the same state.
        let feed = null;
        for (let i = 0; i < 40; i++) {
            feed = await getFeed(feedIndex);
            if (feed && feed.feed_status === 'resolved') break;
            await sleep(3000);
        }
        expect(feed.feed_status, 'market re-settled on node A after the reorg').to.equal('resolved');

        const postB = await rolledBack(bQuery, preB);
        expect(postB, 'node B rolled back and re-indexed the orphaned height on its own').to.not.equal(null);

        const tipA = await tipOf(dbQuery);
        const tipB = await waitNodeB(tipA);
        expect(tipB, 'node B caught up after the reorg').to.be.at.least(tipA);

        const diffs = await compareHashes(startBlock, tipA);
        expect(diffs, 'the two nodes did not re-converge after the reorg:\n'
            + JSON.stringify(diffs.slice(0, 8), null, 1)).to.deep.equal([]);

        // No double credit on EITHER node: exactly one terminal status per bet,
        // read from history rather than inferred from a balance (a compensating
        // pair of errors satisfies a sum).
        for (const [label, q] of [['node A', dbQuery], ['node B', bQuery]]) {
            const rows = await q(
                'SELECT b.action_index, COUNT(*) AS terminal_rows ' +
                '  FROM bets b ' +
                // bet_statuses.action_index is the CAUSING action; the bet is
                // keyed by bet_action_index. Joining on the wrong one counts
                // nothing and passes for the wrong reason.
                '  JOIN bet_statuses bs ON bs.bet_action_index = b.action_index ' +
                '  JOIN index_statuses s ON s.id = bs.status_id ' +
                ' WHERE b.feed_action_index = ? AND s.status IN (\'won\', \'lost\', \'refunded\') ' +
                ' GROUP BY b.action_index', [feedIndex]);
            expect(rows.length, `${label} has both bets in history`).to.equal(2);
            for (const r of rows)
                expect(Number(r.terminal_rows),
                    `${label} credited bet ${r.action_index} exactly once`).to.equal(1);
        }

        const bets = await getBets(feedIndex);
        expect(bets.map(r => r.bet_status).sort(), 'terminal statuses on node A after replay')
            .to.deep.equal(['lost', 'won']);
        amtEq(await balanceOf(p1.address, tick), '14.85', 'winner payout unchanged after the reorg');
    });

    it('sensitivity: a one-node divergence at the latch block is actually caught', async function () {
        if (!following) this.skip();
        // Everything above is a green comparison, and a comparison that cannot
        // fail is worth nothing. So corrupt node B's committed ledger hash at the
        // latch block INSIDE a transaction, re-run the very same comparison over
        // that connection's view, and require it to report the divergence - then
        // roll back and require it to come back clean. Node B's own database, its
        // own connection, never committed.
        const conn = await nodeB.getConnection();
        const tq = (sql, params) => conn.query(sql, params);
        try {
            await conn.beginTransaction();
            const before = await compareHashes(latchBlock, latchBlock, tq);
            expect(before, 'the latch block agrees before the corruption').to.deep.equal([]);

            await conn.query(
                'UPDATE index_transactions SET hash = ? WHERE id = ' +
                '(SELECT ledger_hash_id FROM blocks WHERE block_index = ?)',
                ['de' + 'ad'.repeat(31), latchBlock]);

            const during = await compareHashes(latchBlock, latchBlock, tq);
            expect(during.length, 'the corrupted latch block is reported as divergent').to.equal(1);
            expect(during[0].block, 'reported against the latch block').to.equal(latchBlock);
            expect(during[0].field, 'reported against the hash that moved').to.equal('ledger_hash');
        } finally {
            try { await conn.rollback(); } catch (e) { /* best effort */ }
            try { await conn.release(); } catch (e) { /* best effort */ }
        }

        const after = await compareHashes(latchBlock, latchBlock);
        expect(after, 'node B is untouched once the transaction is rolled back').to.deep.equal([]);
    });
});
