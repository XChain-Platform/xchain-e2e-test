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
 * XChain Platform E2E - BET terminal-path guards (spec §12 E16, E12)
 *
 *   E16 double-credit guard: no bet row may ever be credited twice, and no row
 *       may be summed into a pool after it has left `bet_status = 'open'`.
 *   E12 terminal credits are unconditional: place-time checks gate ENTRY, but
 *       nothing may wedge EXIT, or escrow strands and conservation breaks.
 *
 * E16 is the invariant the §7 pool predicate exists to protect. The spec is
 * blunt about why it is spelled out rather than left to the phrase "valid
 * stakes": cancel already moves bet rows to `refunded` while the feed goes
 * `cancelled`, so an implementer who writes the obvious unfiltered
 * `SUM(amount) WHERE feed_action_index = ? AND outcome = ?` gets a query that is
 * correct only by accident of terminal-path ordering, and double-pays the moment
 * any path refunds a subset. That bug passes E1 and fails in production.
 *
 * Both drills below therefore aim at the same seam from two directions: a
 * SECOND terminal action arriving after a first one has already settled the
 * book, once in the same block and once via the system expiry pass.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, submitOpts, fundedGasAddress } = require('./sdkHelper');
const {
    MIN_REFUND_WINDOW, dbQuery, getFeed, getBets, balanceOf, amtEq, actionIndexOf,
    blockTime, jumpTo, mineAtFrozenClock, resumeMiningAtFrozenClock, releaseClock,
    waitFeedStatus, issueWagerToken, submitBet
} = require('./betHelper');

let sdk, oracle, p1, p2;
let tickSameBlock, tickExpireAfterCancel, tickSleep;

const TERMINAL_BET_STATUSES = ['won', 'lost', 'refunded'];

async function openMarket(tick, label, fee = '2.00', window = 300) {
    const now = await blockTime();
    const deadline = now + window;
    const res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
        label, outcomes: ['Yes', 'No'], tick, fee, deadline,
        refundWindow: MIN_REFUND_WINDOW, now
    }));
    expect(res.indexed.status, `${label}: create status`).to.equal('valid');
    return { feedIndex: actionIndexOf(res), deadline };
}

async function place(who, feedIndex, outcome, amount) {
    const res = await submitBet(sdk, who, sdk.betting.placeBetParams({
        feedActionIndex: feedIndex, outcome, amount }));
    expect(res.indexed.status, `place ${amount}`).to.equal('valid');
    return actionIndexOf(res);
}

// Every bet row must carry EXACTLY ONE terminal status across its whole life.
// Asserted from the status history rather than inferred from balances, because a
// compensating pair of errors satisfies a sum (spec §7).
async function assertOneTerminalCreditPerBet(feedIndex) {
    const rows = await getBets(feedIndex);
    expect(rows.length, 'bets exist to check').to.be.greaterThan(0);

    for (const r of rows) {
        const hist = await dbQuery(
            `SELECT s.status AS status, COUNT(*) AS n
               FROM bet_statuses bs
               INNER JOIN index_statuses s ON s.id = bs.status_id
              WHERE bs.bet_action_index = ?
              GROUP BY s.status`, [r.action_index]);

        const dupes = hist.filter(h => Number(h.n) !== 1).map(h => `${h.status} x${h.n}`);
        expect(dupes.join(', '), `bet ${r.action_index}: no status recorded twice`).to.equal('');

        const terminal = hist.filter(h => TERMINAL_BET_STATUSES.includes(String(h.status)));
        expect(terminal.length,
            `bet ${r.action_index}: exactly one terminal status (saw ${hist.map(h => h.status).join('/')})`)
            .to.equal(1);
    }
    expect(rows.filter(r => r.bet_status === 'open').length,
        'a terminal feed has zero open bets by construction').to.equal(0);
    return rows;
}

describe('[sdk] BET terminal-path guards (§12 E16/E12)', function () {

    before(async function () {
        // See bet.sdk.test.js: ^id compaction outruns the indexer's wire acceptance.
        sdk = makeSdk({ compactAddresses: false });

        oracle = await fundedGasAddress(sdk, 1);
        p1     = await fundedGasAddress(sdk, 1);
        p2     = await fundedGasAddress(sdk, 1);

        tickSameBlock = await issueWagerToken(sdk, oracle, [
            [p1.address, '6.00000000'], [p2.address, '4.00000000']
        ], 1000000, 'B16');

        tickExpireAfterCancel = await issueWagerToken(sdk, oracle, [
            [p1.address, '5.00000000'], [p2.address, '5.00000000']
        ], 1000000, 'B1X');

        tickSleep = await issueWagerToken(sdk, oracle, [
            [p1.address, '8.00000000'], [p2.address, '2.00000000']
        ], 1000000, 'B12');
    });

    after(async function () {
        await releaseClock();
    });

    it('E16a: cancel and resolve in the SAME block settle the book exactly once', async function () {
        const { feedIndex, deadline } = await openMarket(tickSameBlock, 'E16 same-block cancel+resolve');
        await place(p1, feedIndex, 0, '6.00000000');
        await place(p2, feedIndex, 1, '4.00000000');

        // Past the deadline, so a resolve is legal; cancel stays legal on a
        // `closed` feed too, which is what lets both compete in one block.
        await jumpTo(deadline + 60, 2);
        await waitFeedStatus(feedIndex, 'closed');

        const oracleBefore = await balanceOf(oracle.address, tickSameBlock);

        // Broadcast BOTH without waiting, then seal one block over them. The
        // resolve spends the cancel's change, so it must ride the same block and
        // strictly after it: deterministic ordering, cancel first.
        await submit(sdk,
            { action: 'BET', params: sdk.betting.cancelMarketParams({ feedActionIndex: feedIndex }) },
            { pubkey: oracle.address, change: oracle.address },
            submitOpts({ wif: oracle.wif, waitForIndexer: false }));

        await submit(sdk,
            { action: 'BET', params: sdk.betting.resolveMarketParams({ feedActionIndex: feedIndex, outcome: 0 }) },
            { pubkey: oracle.address, change: oracle.address, unconfirmed: true },
            submitOpts({ wif: oracle.wif, waitForIndexer: false }));

        await mineAtFrozenClock(1);
        // Wait for a TERMINAL status specifically. waitFeedStatus(..., null)
        // returns on any non-`open` status, and this feed is already `closed`
        // from the latch, so it would return instantly before either tx confirms.
        let feed = null;
        for (let i = 0; i < 40; i++) {
            feed = await getFeed(feedIndex);
            if (feed && ['cancelled', 'resolved', 'resolved_void', 'expired'].includes(feed.feed_status)) break;
            await mineAtFrozenClock(1);
            await new Promise(r => setTimeout(r, 1500));
        }
        await resumeMiningAtFrozenClock();

        // EXACTLY ONE terminal path may execute. Which one is decided by tx order
        // in the block; what matters is that the loser is a no-op, not a second
        // pass over an already-settled book.
        expect(['cancelled', 'resolved', 'resolved_void'],
            `feed reached a single terminal status (got ${feed.feed_status})`)
            .to.include(feed.feed_status);

        const rows = await assertOneTerminalCreditPerBet(feedIndex);
        const statuses = new Set(rows.map(r => r.bet_status));

        if (feed.feed_status === 'cancelled') {
            expect([...statuses], 'a cancelled feed refunds every stake').to.deep.equal(['refunded']);
            amtEq(await balanceOf(p1.address, tickSameBlock), '6', 'p1 refunded exactly once');
            amtEq(await balanceOf(p2.address, tickSameBlock), '4', 'p2 refunded exactly once');
            amtEq(Number(await balanceOf(oracle.address, tickSameBlock)) - Number(oracleBefore), '0',
                'the losing resolve took no fee on top of the refunds');
        } else {
            // T=10, W=6, fee=floor(10*2/100,8)=0.2, pot=9.8, p1=floor(6*9.8/6,8)=9.8
            amtEq(await balanceOf(p1.address, tickSameBlock), '9.8', 'p1 paid exactly once');
            amtEq(await balanceOf(p2.address, tickSameBlock), '0', 'p2 backed the loser');
            amtEq(Number(await balanceOf(oracle.address, tickSameBlock)) - Number(oracleBefore), '0.2',
                'oracle fee taken exactly once');
        }

        // Conservation: exactly T left escrow, no more and no less.
        const out = Number(await balanceOf(p1.address, tickSameBlock))
                  + Number(await balanceOf(p2.address, tickSameBlock))
                  + (Number(await balanceOf(oracle.address, tickSameBlock)) - Number(oracleBefore));
        amtEq(out, '10', 'sum(credits out) == sum(escrows in) == T, exactly once');
    });

    it('E16b: the expiry pass does not re-refund a feed that was already cancelled', async function () {
        const { feedIndex, deadline } = await openMarket(tickExpireAfterCancel, 'E16 expire-after-cancel');
        await place(p1, feedIndex, 0, '5.00000000');
        await place(p2, feedIndex, 1, '5.00000000');

        // Cancel while still open: bets -> refunded, feed -> cancelled.
        const res = await submitBet(sdk, oracle, sdk.betting.cancelMarketParams({
            feedActionIndex: feedIndex }));
        expect(res.indexed.status, 'cancel status').to.equal('valid');
        expect((await getFeed(feedIndex)).feed_status, 'feed cancelled').to.equal('cancelled');

        amtEq(await balanceOf(p1.address, tickExpireAfterCancel), '5', 'p1 refunded by the cancel');
        amtEq(await balanceOf(p2.address, tickExpireAfterCancel), '5', 'p2 refunded by the cancel');

        // Now sail past expire_at. The expiry pass selects feeds that are still
        // `open` or `closed`; a cancelled feed must be skipped entirely. If the
        // pass ignored the status filter -- or re-summed bets that already left
        // 'open' -- everyone would be paid a second time out of an empty escrow.
        const expireAt = deadline + MIN_REFUND_WINDOW;
        await jumpTo(expireAt + 120, 2);
        await mineAtFrozenClock(2);
        await resumeMiningAtFrozenClock();

        const feed = await getFeed(feedIndex);
        expect(feed.feed_status, 'a cancelled feed stays cancelled past expire_at').to.equal('cancelled');

        amtEq(await balanceOf(p1.address, tickExpireAfterCancel), '5', 'p1 was NOT refunded twice');
        amtEq(await balanceOf(p2.address, tickExpireAfterCancel), '5', 'p2 was NOT refunded twice');
        await assertOneTerminalCreditPerBet(feedIndex);
    });

    it('E12: a sleeping wager tick cannot block terminal credits', async function () {
        const { feedIndex, deadline } = await openMarket(tickSleep, 'E12 sleeping tick', '1.00');
        await place(p1, feedIndex, 0, '8.00000000');
        await place(p2, feedIndex, 1, '2.00000000');

        // Put the wager token to sleep AFTER the stakes are escrowed. Place-time
        // checks gate entry; §7 says terminal credits bypass sleeping checks and
        // token allow/block lists, because anything that can wedge the exit
        // strands escrow and breaks conservation.
        const resumeBlock = (await global.nodeConnector.getBlockCount()) + 100000;
        const sleepRes = await submit(sdk,
            { action: 'SLEEP', params: { version: 1, resumeBlock, tick: tickSleep } },
            { pubkey: oracle.address, change: oracle.address },
            submitOpts({ wif: oracle.wif }));
        expect(sleepRes.indexed.status, 'SLEEP status').to.equal('valid');

        await jumpTo(deadline + 60, 2);
        await waitFeedStatus(feedIndex, 'closed');
        await resumeMiningAtFrozenClock();

        const oracleBefore = await balanceOf(oracle.address, tickSleep);
        const res = await submitBet(sdk, oracle, sdk.betting.resolveMarketParams({
            feedActionIndex: feedIndex, outcome: 0 }));
        expect(res.indexed.status, 'a market on a sleeping tick still resolves').to.equal('valid');

        expect((await getFeed(feedIndex)).feed_status, 'feed resolved').to.equal('resolved');

        // T=10, W=8, fee=floor(10*1/100,8)=0.1, pot=9.9, p1=floor(8*9.9/8,8)=9.9
        amtEq(await balanceOf(p1.address, tickSleep), '9.9',
            'the winner is paid even though the tick is asleep');
        amtEq(await balanceOf(p2.address, tickSleep), '0', 'p2 backed the loser');
        amtEq(Number(await balanceOf(oracle.address, tickSleep)) - Number(oracleBefore), '0.1',
            'the oracle fee lands too');
        await assertOneTerminalCreditPerBet(feedIndex);
    });
});
