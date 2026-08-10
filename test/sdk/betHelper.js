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
 **********************************************************************
 *
 * XChain Platform E2E - shared helpers for the BET drills (spec §12)
 *
 * Betting is time-gated on BLOCK_TIME rather than block height: a feed closes
 * to new bets at DEADLINE, resolves in [DEADLINE, expire_at), and expires at
 * expire_at = DEADLINE + REFUND_WINDOW. The regtest node's clock is therefore
 * a first-class test fixture here, driven through setmocktime exactly as
 * test/actions/coinpay.test.js drives obligation expiry.
 *
 * MIN_BET_REFUND_WINDOW is 3600, so the shortest legal market still spans an
 * hour of wall time. Every drill past "place a bet" has to jump the clock;
 * none of them can wait it out.
 *
 ********************************************************************/

const { submit, submitOpts, uniqueTick } = require('./sdkHelper');

// Mirrors the SDK's BET_LIMITS for the values the drills assert against.
const MIN_REFUND_WINDOW = 3600;

async function dbQuery(sql, params) {
    const connection = await global.indexerDatabase.getConnection();
    try { return await connection.query(sql, params); }
    finally { await connection.release(); }
}

// Feed row with both status strings resolved out of the index_statuses
// indirection (feed_status is the lifecycle status the drills assert on;
// status is the parse status of the create tx itself).
async function getFeed(actionIndex) {
    const rows = await dbQuery(
        `SELECT f.*, s1.status AS parse_status, s2.status AS feed_status, t.tick
           FROM bet_feeds f
           INNER JOIN index_statuses s1 ON s1.id = f.status_id
           INNER JOIN index_statuses s2 ON s2.id = f.feed_status_id
           LEFT  JOIN index_tickers  t  ON t.id  = f.tick_id
          WHERE f.action_index = ?`, [actionIndex]);
    return rows.length ? rows[0] : null;
}

// Bets on a feed in settlement order (action_index ASC is the consensus
// iteration order for payouts, so the drills read them the same way).
// `parse_status` is the status of the PLACE action itself and carries the
// rejection reason verbatim ("invalid: OUTCOME (range)"); `bet_status` is the
// row's lifecycle state (open/won/lost/refunded, or 'invalid' when the place
// never took). A rejected bet still writes a row, so the negative drills read
// the reason from here rather than trusting the SDK's return shape.
async function getBets(feedActionIndex) {
    return await dbQuery(
        `SELECT b.*, s.status AS bet_status, p.status AS parse_status, a.address AS source
           FROM bets b
           INNER JOIN index_statuses  s  ON s.id = b.bet_status_id
           INNER JOIN index_statuses  p  ON p.id = b.status_id
           INNER JOIN actions         ac ON ac.action_index = b.action_index
           INNER JOIN index_addresses a  ON a.id = ac.source_id
          WHERE b.feed_action_index = ?
          ORDER BY b.action_index ASC`, [feedActionIndex]);
}

async function balanceOf(address, tick) {
    const rows = await dbQuery(
        `SELECT b.amount FROM balances b
           JOIN index_addresses ia ON ia.id = b.address_id
           JOIN index_tickers   it ON it.id = b.tick_id
          WHERE ia.address = ? AND it.tick = ?`, [address, tick]);
    return rows.length ? String(rows[0].amount) : '0';
}

// Escrow rows are pushed as a matching debits+escrows pair at place time and a
// NEGATIVE escrows row at release, so the live escrow is the running SUM.
async function escrowOf(address, tick) {
    const rows = await dbQuery(
        `SELECT COALESCE(SUM(e.amount), 0) AS total FROM escrows e
           JOIN index_addresses ia ON ia.id = e.address_id
           JOIN index_tickers   it ON it.id = e.tick_id
          WHERE ia.address = ? AND it.tick = ?`, [address, tick]);
    return rows.length ? String(rows[0].total) : '0';
}

// Amounts round-trip through mathjs bignumber, which normalizes '13.86000000'
// to '13.86' and one base unit to '1e-8'. Compare by value, never by the
// stored string, or a drill fails on formatting instead of on consensus.
function amtEq(actual, expected, message) {
    const a = Number(actual);
    const b = Number(expected);
    if (Math.abs(a - b) > 1e-9)
        throw new Error(`${message || 'amount mismatch'}: expected ${expected}, got ${actual}`);
}

function actionIndexOf(res) {
    const actions = res && res.indexed && res.indexed.actions;
    if (!Array.isArray(actions) || actions.length === 0)
        throw new Error('submitAction result carried no indexed actions');
    return actions[0].action_index;
}

// The CHAIN's current block time, which under setmocktime is nowhere near wall
// time. Read from the indexer's own tip rather than by looking up the node's
// height: the indexer routinely trails the node by a block or two, so a
// height-keyed lookup misses and any wall-clock fallback silently hands back a
// timestamp hours away from the chain's. That exact fallback produced a run
// where every market was rejected `invalid: DEADLINE (past)` and the follow-up
// jump drove the clock BACKWARDS and wedged the miner. There is no sane default
// here, so this throws rather than guesses.
async function blockTime() {
    // Let the indexer catch up to the node first. Right after a clock jump the
    // node's tip carries the new time while the indexer is still a block or two
    // behind, so reading the indexer alone hands back a PRE-jump timestamp.
    // A deadline computed from that is already in the chain's past, and the
    // follow-up jump then looks like a rewind. Observed exactly that on E12.
    const settleBy = Date.now() + 60000;
    while (Date.now() < settleBy) {
        let nodeHeight = null;
        try { nodeHeight = await global.nodeConnector.getBlockCount(); } catch (e) { break; }
        const tip = await dbQuery('SELECT MAX(block_index) AS tip FROM blocks', []);
        if (tip.length && tip[0].tip != null && Number(tip[0].tip) >= Number(nodeHeight)) break;
        await new Promise(r => setTimeout(r, 1500));
    }

    const rows = await dbQuery('SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1', []);
    if (!rows.length || rows[0].block_time == null)
        throw new Error('betHelper.blockTime: the indexer has no blocks; is the stack up?');
    return Number(rows[0].block_time);
}

// Freeze the shared regtest node's clock at `timestamp` and mine `blocks` at
// that time, so a block lands with block_time >= timestamp and the end-of-block
// BET pass sees a crossed deadline. The caller MUST eventually releaseClock();
// every drill does it from an after() hook so a mid-test failure cannot leave
// the shared node time-frozen for the next suite.
async function jumpTo(timestamp, blocks = 2) {
    // Refuse to move the clock BACKWARDS. A block must still out-timestamp the
    // median of the last 11, so rewinding the node's clock leaves every
    // candidate block simultaneously forced above the tip and rejected as
    // "too far in the future" -- block production stops dead for the whole
    // stack, and the test that caused it fails somewhere else entirely. Fail
    // loudly and locally instead.
    const tip = await blockTime();
    const target = Math.floor(timestamp);
    if (target < tip)
        throw new Error(`betHelper.jumpTo: refusing to rewind the chain clock from ${tip} to ${target}`
            + ' (this wedges block production; compute deadlines from blockTime(), not Date.now())');

    await global.regtestMinerConnector.setMiningTime(3600000, 3600000);
    // Reached through the miner rather than node RPC: the miner owns the node
    // connection and some installs do not publish the node's RPC port.
    await global.regtestMinerConnector.setMockTime(target);
    await global.regtestMinerConnector.generateBlocks(blocks);
}

// Median time past: the median block_time of the last 11 blocks, which is the
// floor bitcoind enforces on the next block's timestamp (BIP113).
async function medianTimePast() {
    // Sync first. A stale view here is worse than useless: it under-reports MTP,
    // so a backdate that bitcoind will actually reject as too low looks safe, and
    // the block silently lands at MTP+1 instead of the requested timestamp.
    await blockTime();
    const rows = await dbQuery('SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 11', []);
    if (!rows.length) throw new Error('betHelper.medianTimePast: no blocks indexed');
    const times = rows.map(r => Number(r.block_time)).sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
}

// The highest block timestamp the chain carries. After a backdated block the
// TIP's own time is no longer the maximum, so anything that needs to keep the
// clock legal has to look at the max, not the tip.
async function maxBlockTime() {
    const rows = await dbQuery('SELECT MAX(block_time) AS mx FROM blocks', []);
    return rows.length && rows[0].mx != null ? Number(rows[0].mx) : 0;
}

// Deliberately move the clock BACKWARDS, for the backdating drill only.
//
// This is the one place a rewind is the point rather than a bug: E11 has to mine
// a block whose timestamp predates the DEADLINE a previous block already
// crossed. It is only safe while the target still clears median-time-past --
// otherwise bitcoind would be forced to stamp the block at MTP+1, which can sit
// hours beyond the node's rewound clock and wedge block production exactly as
// releaseClock's comment describes. So this REFUSES rather than risking the
// shared stack, and the caller skips the drill.
async function backdateTo(timestamp) {
    const target = Math.floor(timestamp);
    const mtp = await medianTimePast();
    if (target <= mtp)
        return { ok: false, reason: `target ${target} is not above median-time-past ${mtp}` };
    await global.regtestMinerConnector.setMiningTime(3600000, 3600000);
    await global.regtestMinerConnector.setMockTime(target);
    return { ok: true, mtp };
}

// Move the clock WITHOUT mining, and park the auto-miner so nothing slips in.
//
// This is what the boundary drills need: to observe a user tx competing with the
// end-of-block pass in the SAME block, the tx has to reach the mempool while the
// clock already reads past the boundary but no block has been sealed yet. jumpTo
// mines immediately, which lets the pass fire before the tx is ever broadcast.
async function setClock(timestamp) {
    const tip = await blockTime();
    const target = Math.floor(timestamp);
    if (target < tip)
        throw new Error(`betHelper.setClock: refusing to rewind the chain clock from ${tip} to ${target}`);
    await global.regtestMinerConnector.setMiningTime(3600000, 3600000);
    await global.regtestMinerConnector.setMockTime(target);
}

// Mine further blocks while the clock stays frozen (the system passes are
// per-block, so a deferred feed needs additional blocks at the same time).
async function mineAtFrozenClock(blocks = 1) {
    await global.regtestMinerConnector.generateBlocks(blocks);
}

// Restore the normal mining cadence while LEAVING the clock frozen. jumpTo
// parks the auto-miner so no block can slip in below the target timestamp;
// broadcasting a tx afterwards needs blocks again, and with mocktime still set
// every one of them carries the frozen time. This is how a resolve tx gets
// mined at BLOCK_TIME >= DEADLINE.
async function resumeMiningAtFrozenClock() {
    await global.regtestMinerConnector.setDefaultMiningTime();
}

// Hand the shared regtest node back in a MINEABLE state.
//
// Do NOT simply setMockTime(0) here. These drills walk the chain clock ahead of
// wall time, and bitcoind refuses to build a block whose timestamp is more than
// two hours ahead of its own clock -- while the tip's own timestamp is the floor
// for the next block. Releasing the mock clock with the tip hours ahead
// therefore wedges the miner permanently ("TestBlockValidity failed:
// time-too-new"), taking the whole stack down for every later suite. Observed
// for real during E1 bring-up: the tip sat 9835s ahead and mining stopped dead.
//
// So: release only when wall time has caught up, and otherwise pin the clock
// just past the tip, which keeps block production legal and lets real time
// close the gap on its own.
async function releaseClock() {
    try {
        // MAX(block_time), not the tip's: the backdating drill leaves a tip whose
        // timestamp is lower than blocks beneath it, and pinning to that would
        // put the clock under median-time-past and wedge mining anyway.
        const tip = await maxBlockTime();
        const now = Math.floor(Date.now() / 1000);
        await global.regtestMinerConnector.setMockTime(tip > now ? tip + 5 : 0);
    } catch (e) { /* best effort */ }
    try { await global.regtestMinerConnector.setDefaultMiningTime(); } catch (e) { /* best effort */ }
}

// Wait for a feed status WITHOUT mining. The mining variant below adds a block
// per poll, which is usually what drives the pass along, but every one of those
// blocks carries the frozen timestamp and so drags median-time-past up with it.
// The backdating drill needs MTP to stay low, so once the crossing block is
// already mined it must wait, not mine.
async function waitFeedStatusNoMine(feedIndex, wanted, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const feed = await getFeed(feedIndex);
        if (feed && (wanted ? feed.feed_status === wanted : feed.feed_status !== 'open')) return feed;
        await new Promise(r => setTimeout(r, 1500));
    }
    return await getFeed(feedIndex);
}

// Poll the indexer until the feed reaches `wanted` (or any terminal status when
// wanted is null), mining at the frozen clock to drive the per-block pass.
async function waitFeedStatus(feedIndex, wanted, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const feed = await getFeed(feedIndex);
        if (feed && (wanted ? feed.feed_status === wanted : feed.feed_status !== 'open')) return feed;
        await mineAtFrozenClock(1);
        await new Promise(r => setTimeout(r, 1500));
    }
    return await getFeed(feedIndex);
}

// Issue a fresh divisible (8dp) wager token and hand `stakes` out to bettors.
// Returns the tick. The issuer keeps whatever is left of mintSupply.
async function issueWagerToken(sdk, issuer, distributions, mintSupply = 1000000, prefix = 'BET') {
    const tick = uniqueTick(prefix);
    const res = await submit(sdk,
        { action: 'ISSUE', params: {
            tick, maxSupply: 100000000, maxMint: 10000000, decimals: 8,
            description: 'bet drill wager token', mintSupply } },
        { pubkey: issuer.address, change: issuer.address },
        submitOpts({ wif: issuer.wif })
    );
    if (res.indexed.status !== 'valid')
        throw new Error(`ISSUE of wager token failed: ${res.indexed.status}`);

    for (const [dest, amount] of distributions) {
        const sendRes = await submit(sdk,
            { action: 'SEND', params: { tick, amount, destination: dest } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        if (sendRes.indexed.status !== 'valid')
            throw new Error(`SEND of wager token to ${dest} failed: ${sendRes.indexed.status}`);
    }
    return tick;
}

// Submit a BET action of any format from `signer`, returning the raw result so
// the negative drills can assert on an invalid status rather than throwing.
async function submitBet(sdk, signer, params) {
    return await submit(sdk,
        { action: 'BET', params },
        { pubkey: signer.address, change: signer.address },
        submitOpts({ wif: signer.wif })
    );
}

module.exports = {
    MIN_REFUND_WINDOW,
    dbQuery,
    getFeed,
    getBets,
    balanceOf,
    escrowOf,
    amtEq,
    actionIndexOf,
    blockTime,
    jumpTo,
    setClock,
    medianTimePast,
    maxBlockTime,
    backdateTo,
    mineAtFrozenClock,
    resumeMiningAtFrozenClock,
    releaseClock,
    waitFeedStatus,
    waitFeedStatusNoMine,
    issueWagerToken,
    submitBet
};
