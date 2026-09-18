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
 ********************************************************************/

const { expect } = require('chai');
const path       = require('path');
const cryptoHelper = require('../../../cryptoHelper');
const { dbQuery } = require('../../betHelper');

// The follower's copy of the state-hash preimage builder. Byte-aligned twin of
// xchain-indexer/src/consensus/state_hash.js (their equality is locked by
// consensusHashConformance.test.js), so using the follower's here recomputes
// what a real replica would compute rather than re-running the source's own
// code against its own rows. Absent sibling => that leg skips, as elsewhere.
let syncBuildStateHashData, SyncUtility;
try {
    ({ buildStateHashData: syncBuildStateHashData } =
        require(path.join(__dirname, '../../../../../xchain-sync/src/consensus/state_hash.js')));
    SyncUtility = require(path.join(__dirname, '../../../../../xchain-sync/src/util/index.js'));
} catch (e) {
    // Strict runs lay every sibling, so a load failure there is a moved or broken
    // file, never an absent checkout, and must not reach the call site as a skip.
    if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw e;
}

// BTC's frozen ACTIVATION_DELAY_BLOCKS (src/coins/BTC.js). Only reaches the
// staking-deactivation class of the preimage, which is empty for these blocks,
// but the recompute must still pass what the node passed.
const ACTIVATION_DELAY_BLOCKS = parseInt(process.env.E2E_ACTIVATION_DELAY_BLOCKS) || 6;

const state = {
    nodeB: null,
    mirrorTimer: null,
    // Set by the first drill. Everything after it needs a node B that is
    // actually following the chain; without this the whole file grinds through a
    // full lifecycle and several multi-minute waits before reporting the one
    // thing that was wrong, and does it against the shared venue.
    following: false
};

function haveConnectors() {
    return global.nodeConnector && global.regtestMinerConnector && global.indexerDatabase;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function bQuery(sql, params) {
    const connection = await state.nodeB.getConnection();
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

module.exports = {
    ACTIVATION_DELAY_BLOCKS,
    SyncUtility,
    state,
    syncBuildStateHashData,
    haveConnectors,
    sleep,
    bQuery,
    tipOf,
    hashesOf,
    compareHashes,
    betClasses,
    waitNodeB,
    levelNodes,
    mirrorOracleTables,
    blockIndexOfAction,
    reorgPast
};
