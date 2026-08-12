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
 * XChain Platform E2E - BET expiry + the resolve/expire boundary (§12 E4, E7)
 *
 *   E4 expiry: nobody resolves, so BET_EXPIRE refunds every stake at
 *      `expire_at` and the feed goes `expired`. Includes the case where a
 *      single large time jump makes a feed latch AND expire in the same pass.
 *   E7 boundary: the consensus tie-breaks around `expire_at`, which must be
 *      deterministic on every node regardless of where a tx sits in the block.
 *
 * The boundary rule (spec §6) is that user transactions are processed BEFORE
 * the end-of-block system pass, so:
 *
 *   - a resolve in a block where BLOCK_TIME >= expire_at is INVALID, and the
 *     pass in that same block expires the feed: expiry wins
 *   - a resolve one block EARLIER is valid, and the pass then skips the feed
 *     because it is no longer open/closed
 *   - a cancel in that same boundary block is VALID and preempts expiry, since
 *     format 1 carries no clock bound; both paths refund identically and only
 *     the terminal status differs
 *
 * Getting a user tx INTO the boundary block is the whole trick here: the clock
 * has to be moved past the boundary with the miner parked, the tx broadcast into
 * the mempool, and only then a block sealed. `setClock` exists for exactly that,
 * because `jumpTo` mines immediately and the pass would fire first.
 *
 * NOT covered, and not coverable here: the spec's fourth E7 case, a cancel in a
 * LATER block on a feed whose expiry pass was DEFERRED. Deferral needs more than
 * MAX_BET_PASS_ROWS (5000) feeds due in one block, i.e. 5001 transactions, the
 * same reason E18 stays unit-covered.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, submitOpts, fundedGasAddress } = require('./sdkHelper');
const {
    MIN_REFUND_WINDOW, dbQuery, getFeed, getBets, balanceOf, amtEq, actionIndexOf,
    blockTime, jumpTo, setClock, mineAtFrozenClock, resumeMiningAtFrozenClock,
    releaseClock, waitFeedStatus, issueWagerToken, submitBet
} = require('./betHelper');

let sdk, oracle, p1, p2;
let tickPlain, tickSamePass, tickBoundary, tickEarly, tickCancelWins;

async function openMarket(tick, label, windowSeconds = 300) {
    const now = await blockTime();
    const deadline = now + windowSeconds;
    const res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
        label, outcomes: ['Yes', 'No'], tick, fee: '2.00', deadline,
        refundWindow: MIN_REFUND_WINDOW, now
    }));
    expect(res.indexed.status, `${label}: create status`).to.equal('valid');
    const feedIndex = actionIndexOf(res);
    return { feedIndex, deadline, expireAt: deadline + MIN_REFUND_WINDOW };
}

async function placeBoth(feedIndex, a1, a2) {
    const r1 = await submitBet(sdk, p1, sdk.betting.placeBetParams({
        feedActionIndex: feedIndex, outcome: 0, amount: a1 }));
    expect(r1.indexed.status, 'p1 place status').to.equal('valid');
    const r2 = await submitBet(sdk, p2, sdk.betting.placeBetParams({
        feedActionIndex: feedIndex, outcome: 1, amount: a2 }));
    expect(r2.indexed.status, 'p2 place status').to.equal('valid');
}

// Broadcast into the mempool without waiting for indexing, so the caller
// controls which block the tx lands in.
async function broadcast(params) {
    return submit(sdk,
        { action: 'BET', params },
        { pubkey: oracle.address, change: oracle.address },
        submitOpts({ wif: oracle.wif, waitForIndexer: false }));
}

async function waitTerminal(feedIndex, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let feed = null;
    while (Date.now() < deadline) {
        feed = await getFeed(feedIndex);
        if (feed && ['expired', 'resolved', 'resolved_void', 'cancelled'].includes(feed.feed_status)) return feed;
        await mineAtFrozenClock(1);
        await new Promise(r => setTimeout(r, 1500));
    }
    return feed;
}

async function assertOneTerminalStatusPerBet(feedIndex) {
    const rows = await getBets(feedIndex);
    for (const r of rows) {
        const hist = await dbQuery(
            `SELECT s.status AS status, COUNT(*) AS n
               FROM bet_statuses bs
               INNER JOIN index_statuses s ON s.id = bs.status_id
              WHERE bs.bet_action_index = ?
              GROUP BY s.status`, [r.action_index]);
        const dupes = hist.filter(h => Number(h.n) !== 1).map(h => `${h.status} x${h.n}`);
        expect(dupes.join(', '), `bet ${r.action_index}: no status recorded twice`).to.equal('');
        expect(hist.filter(h => ['won', 'lost', 'refunded'].includes(String(h.status))).length,
            `bet ${r.action_index}: exactly one terminal status`).to.equal(1);
    }
    return rows;
}

describe('[sdk] BET expiry + resolve/expire boundary (§12 E4/E7)', function () {

    before(async function () {
        // See bet.sdk.test.js: ^id compaction outruns the indexer's wire acceptance.
        sdk = makeSdk({ compactAddresses: false });
        oracle = await fundedGasAddress(sdk, 1);
        p1     = await fundedGasAddress(sdk, 1);
        p2     = await fundedGasAddress(sdk, 1);

        const stakes = [[p1.address, '6.00000000'], [p2.address, '4.00000000']];
        tickPlain      = await issueWagerToken(sdk, oracle, stakes, 1000000, 'BX1');
        tickSamePass   = await issueWagerToken(sdk, oracle, stakes, 1000000, 'BX2');
        tickBoundary   = await issueWagerToken(sdk, oracle, stakes, 1000000, 'BX3');
        tickEarly      = await issueWagerToken(sdk, oracle, stakes, 1000000, 'BX4');
        tickCancelWins = await issueWagerToken(sdk, oracle, stakes, 1000000, 'BX5');
    });

    after(async function () {
        await releaseClock();
    });

    it('E4a: an unresolved feed expires at expire_at and refunds every stake', async function () {
        const { feedIndex, deadline, expireAt } = await openMarket(tickPlain, 'E4 plain expiry');
        await placeBoth(feedIndex, '6.00000000', '4.00000000');

        const oracleBefore = await balanceOf(oracle.address, tickPlain);

        // Cross the deadline first: the feed latches closed but stays refundable.
        await jumpTo(deadline + 60, 2);
        const latched = await waitFeedStatus(feedIndex, 'closed');
        expect(latched.feed_status, 'latched closed at the deadline').to.equal('closed');

        // Now cross expire_at with nobody having resolved.
        await jumpTo(expireAt + 60, 2);
        const feed = await waitTerminal(feedIndex);
        await resumeMiningAtFrozenClock();

        expect(feed.feed_status, 'the oracle never resolved, so the feed expired').to.equal('expired');
        expect(Number(feed.terminal_block), 'terminal_block stamped by the expiry pass').to.be.greaterThan(0);

        // Refunds are IN FULL and take no fee, exactly like cancel: expiry is a
        // non-event, not a settlement.
        amtEq(await balanceOf(p1.address, tickPlain), '6', 'p1 refunded in full');
        amtEq(await balanceOf(p2.address, tickPlain), '4', 'p2 refunded in full');
        amtEq(Number(await balanceOf(oracle.address, tickPlain)) - Number(oracleBefore), '0',
            'NO oracle fee on expiry, even at FEE=2%');

        const rows = await assertOneTerminalStatusPerBet(feedIndex);
        expect(rows.map(r => r.bet_status), 'every stake refunded').to.deep.equal(['refunded', 'refunded']);
        expect(rows.filter(r => r.bet_status === 'open').length, 'nothing left open').to.equal(0);
    });

    it('E4b: a single large jump latches AND expires the feed in the same pass', async function () {
        const { feedIndex, expireAt } = await openMarket(tickSamePass, 'E4 latch+expire same pass');
        await placeBoth(feedIndex, '6.00000000', '4.00000000');

        // Jump clean past expire_at without ever sealing a block in the
        // [deadline, expire_at) window, so the feed is still `open` when the pass
        // runs: the latch step must close it and the expiry step must then pick it
        // up within that SAME pass.
        await jumpTo(expireAt + 120, 2);
        const feed = await waitTerminal(feedIndex);
        await resumeMiningAtFrozenClock();

        expect(feed.feed_status, 'feed expired despite never being latched in an earlier block')
            .to.equal('expired');
        // The latch still leaves its stamp: the two steps run in order inside one pass.
        expect(feed.closed_block, 'closed_block stamped by the latch step of the same pass')
            .to.not.equal(null);
        expect(Number(feed.terminal_block), 'terminal_block stamped by the expiry step')
            .to.be.at.least(Number(feed.closed_block));

        amtEq(await balanceOf(p1.address, tickSamePass), '6', 'p1 refunded in full');
        amtEq(await balanceOf(p2.address, tickSamePass), '4', 'p2 refunded in full');
        await assertOneTerminalStatusPerBet(feedIndex);
    });

    it('E7a: a resolve in the boundary block LOSES to expiry', async function () {
        const { feedIndex, expireAt } = await openMarket(tickBoundary, 'E7 resolve vs expiry');
        await placeBoth(feedIndex, '6.00000000', '4.00000000');

        const oracleBefore = await balanceOf(oracle.address, tickBoundary);

        // Clock past expire_at, miner parked, nothing sealed yet.
        await setClock(expireAt + 60);
        await broadcast(sdk.betting.resolveMarketParams({ feedActionIndex: feedIndex, outcome: 0 }));
        // Seal the boundary block: user txs process first (the resolve is rejected
        // for being past the refund window), then the pass expires the feed.
        await mineAtFrozenClock(1);

        const feed = await waitTerminal(feedIndex);
        await resumeMiningAtFrozenClock();

        expect(feed.feed_status, 'expiry wins the boundary block, not the resolve').to.equal('expired');

        // Refunds, not payouts: had the resolve won, p1 would hold ~9.8 and the
        // oracle a fee.
        amtEq(await balanceOf(p1.address, tickBoundary), '6', 'p1 refunded, not paid out');
        amtEq(await balanceOf(p2.address, tickBoundary), '4', 'p2 refunded, not consumed as a loser');
        amtEq(Number(await balanceOf(oracle.address, tickBoundary)) - Number(oracleBefore), '0',
            'the losing resolve took no fee');
        await assertOneTerminalStatusPerBet(feedIndex);
    });

    it('E7b: a resolve one block EARLIER wins, and the pass then skips the feed', async function () {
        const { feedIndex, deadline, expireAt } = await openMarket(tickEarly, 'E7 resolve before window closes');
        await placeBoth(feedIndex, '6.00000000', '4.00000000');

        // Land the resolve strictly inside [deadline, expire_at).
        await jumpTo(deadline + 60, 2);
        await waitFeedStatus(feedIndex, 'closed');
        await resumeMiningAtFrozenClock();

        const oracleBefore = await balanceOf(oracle.address, tickEarly);
        const res = await submitBet(sdk, oracle, sdk.betting.resolveMarketParams({
            feedActionIndex: feedIndex, outcome: 0 }));
        expect(res.indexed.status, 'in-window resolve is valid').to.equal('valid');
        expect((await getFeed(feedIndex)).feed_status, 'feed resolved').to.equal('resolved');

        // T=10, W=6, fee=floor(10*2/100,8)=0.2, pot=9.8, p1=floor(6*9.8/6,8)=9.8
        amtEq(await balanceOf(p1.address, tickEarly), '9.8', 'p1 paid out');

        // Sail past expire_at. The pass selects only open/closed feeds, so a
        // resolved one must be left completely alone: no second refund, no
        // status churn.
        await jumpTo(expireAt + 120, 2);
        await mineAtFrozenClock(2);
        await resumeMiningAtFrozenClock();

        const feed = await getFeed(feedIndex);
        expect(feed.feed_status, 'a resolved feed stays resolved past expire_at').to.equal('resolved');
        amtEq(await balanceOf(p1.address, tickEarly), '9.8', 'p1 was not refunded on top of the payout');
        amtEq(await balanceOf(p2.address, tickEarly), '0', 'the loser was not refunded by the pass');
        amtEq(Number(await balanceOf(oracle.address, tickEarly)) - Number(oracleBefore), '0.2',
            'oracle fee unchanged after expire_at passed');
        await assertOneTerminalStatusPerBet(feedIndex);
    });

    it('E7c: a cancel in the boundary block PREEMPTS expiry', async function () {
        const { feedIndex, expireAt } = await openMarket(tickCancelWins, 'E7 cancel preempts expiry');
        await placeBoth(feedIndex, '6.00000000', '4.00000000');

        await setClock(expireAt + 60);
        // Format 1 carries NO clock bound by design, so a cancel stays valid on any
        // feed still open/closed, including one already past expire_at. It is
        // processed before the pass, so it takes the terminal slot.
        await broadcast(sdk.betting.cancelMarketParams({ feedActionIndex: feedIndex }));
        await mineAtFrozenClock(1);

        const feed = await waitTerminal(feedIndex);
        await resumeMiningAtFrozenClock();

        expect(feed.feed_status, 'cancel preempts expiry in the boundary block').to.equal('cancelled');

        // Both paths refund identically; only the terminal status differs, which
        // is why this is safe rather than a race.
        amtEq(await balanceOf(p1.address, tickCancelWins), '6', 'p1 refunded in full');
        amtEq(await balanceOf(p2.address, tickCancelWins), '4', 'p2 refunded in full');
        await assertOneTerminalStatusPerBet(feedIndex);
    });
});
