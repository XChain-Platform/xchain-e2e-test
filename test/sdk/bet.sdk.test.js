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
 * XChain Platform E2E - BET settlement drills (spec §12 E1, E2, E3, E10)
 *
 *   E1  happy path: the §7 worked example, asserted to the base unit
 *   E2  multiple bets from one address settle pro-rata PER ROW
 *   E3  W = 0 -> full refunds, no fee, resolved_void
 *   E10 rake (W == T) including a winning payout that floors to zero
 *
 * The §7 worked example is the shared test vector between the P1 docs and this
 * drill, so E1's numbers are quoted from the spec rather than recomputed:
 * tick d=8, FEE=1.00 (one percent). A stakes 10.0 on outcome 0, B stakes 5.0 on
 * outcome 1, C stakes 2.5 on outcome 0; resolve to outcome 0.
 *
 *   T = 17.5, W = 12.5, fee = floor(17.5 * 1/100, 8) = 0.175, pot = 17.325
 *   A = floor(10 * 17.325 / 12.5, 8) = 13.86
 *   C = floor(2.5 * 17.325 / 12.5, 8) = 3.465
 *   paid = 17.325, dust = 0, oracle = 0.175
 *   conservation: 13.86 + 3.465 + 0.175 = 17.5 = T
 *
 * Structure note (learned the hard way): ALL funding and token distribution
 * happens in the root before(), ahead of any clock manipulation, and the chain
 * clock thereafter only ever moves FORWARD. Funding a new address after a
 * setmocktime jump has been released fails in the encoder ("no utxos found"),
 * because the freshly mined real-time blocks sit behind the chain's own tip
 * time. Keeping the clock monotonic also makes the drills more deterministic:
 * while it is frozen every block carries the same timestamp.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, fundedGasAddress } = require('./sdkHelper');
const {
    MIN_REFUND_WINDOW, getFeed, getBets, balanceOf, amtEq, actionIndexOf,
    blockTime, jumpTo, resumeMiningAtFrozenClock, releaseClock, waitFeedStatus,
    issueWagerToken, submitBet
} = require('./betHelper');

// One oracle and three punters, reused across the drills; each drill gets its
// OWN wager tick, so balances can never bleed between them.
let sdk, oracle, p1, p2, p3;
let tickE1, tickE2, tickE3, tickE10;

// Open a market from the oracle and return its action index plus the deadline
// the drill must jump past. The deadline is computed from the CURRENT block
// time because earlier drills have already walked the clock forward, and a
// deadline in the chain's past is rejected at parse.
async function openMarket({ outcomes, tick, fee, label, minAmount }) {
    const now = await blockTime();
    // Deliberately a SMALL offset. Each drill walks the chain clock forward by
    // roughly this much, and a chain left hours ahead of wall time wedges the
    // miner (see releaseClock in betHelper). Five minutes is ample: once the
    // first jump freezes the clock, block time stops advancing on its own, so
    // the window only has to cover bets placed under a stopped clock.
    const deadline = now + 300;
    const res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
        label, outcomes, tick, fee, deadline,
        refundWindow: MIN_REFUND_WINDOW, minAmount, now
    }));
    expect(res.indexed.status, 'market create status').to.equal('valid');
    return { feedIndex: actionIndexOf(res), deadline };
}

async function place(who, feedIndex, outcome, amount) {
    const res = await submitBet(sdk, who, sdk.betting.placeBetParams({
        feedActionIndex: feedIndex, outcome, amount
    }));
    expect(res.indexed.status, `place ${amount} on outcome ${outcome}`).to.equal('valid');
    return actionIndexOf(res);
}

// Jump past the deadline so the end-of-block pass latches the feed, then
// resolve. Mining resumes at the frozen clock so the resolve tx is mined with
// BLOCK_TIME >= DEADLINE and still inside the refund window.
async function closeAndResolve(feedIndex, deadline, outcome) {
    await jumpTo(deadline + 60, 2);
    const latched = await waitFeedStatus(feedIndex, 'closed');
    expect(latched.feed_status, 'feed latched closed before resolve').to.equal('closed');
    await resumeMiningAtFrozenClock();
    const res = await submitBet(sdk, oracle, sdk.betting.resolveMarketParams({
        feedActionIndex: feedIndex, outcome
    }));
    expect(res.indexed.status, 'resolve status').to.equal('valid');
}

describe('[sdk] BET settlement drills (§12 E1/E2/E3/E10)', function () {

    before(async function () {
        // compactAddresses off: the SDK's ^id destination compaction runs ahead of
        // the indexer's wire acceptance (the P4-arming open item), which invalidates
        // the setup SENDs that hand stakes to bettors. Same stance as the VOTE
        // suites. BET's own formats carry no address fields, so nothing under test
        // is affected.
        sdk = makeSdk({ compactAddresses: false });

        oracle = await fundedGasAddress(sdk, 1);
        p1     = await fundedGasAddress(sdk, 1);
        p2     = await fundedGasAddress(sdk, 1);
        p3     = await fundedGasAddress(sdk, 1);

        // Each punter is funded with EXACTLY what that drill has them stake, so a
        // final balance is the payout and nothing else.
        tickE1 = await issueWagerToken(sdk, oracle, [
            [p1.address, '10.00000000'], [p2.address, '5.00000000'], [p3.address, '2.50000000']
        ], 1000000, 'BE1');

        tickE2 = await issueWagerToken(sdk, oracle, [
            [p1.address, '20.00000000'], [p2.address, '10.00000000']
        ], 1000000, 'BE2');

        tickE3 = await issueWagerToken(sdk, oracle, [
            [p1.address, '7.00000000'], [p2.address, '3.00000000']
        ], 1000000, 'BE3');

        tickE10 = await issueWagerToken(sdk, oracle, [
            [p1.address, '10.00000000'], [p2.address, '0.00000001']   // one base unit
        ], 1000000, 'B10');
    });

    after(async function () {
        await releaseClock();
    });

    describe('E1: happy-path settlement matches the §7 worked example', function () {

        let feedIndex, deadline, oracleBefore;

        it('creates the market with DETAILS cross-checked against OUTCOMES', async function () {
            const now = await blockTime();
            // Wider than the later drills': this is the only market opened while
            // the clock still runs at wall speed, so the window has to cover the
            // three bets actually confirming.
            deadline = now + 900;

            const res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
                label:        'Will the E1 drill settle exactly?',
                outcomes:     ['Yes', 'No'],
                tick:         tickE1,
                fee:          '1.00',
                deadline,
                refundWindow: MIN_REFUND_WINDOW,
                details: {
                    title:               'E1 settlement drill',
                    description:         'Shared worked-example vector from BETTING_SYSTEM_SPEC §7.',
                    outcomes:            ['Yes', 'No'],
                    resolution_criteria: 'Resolves to outcome 0 by the drill.',
                    category:            'test'
                },
                now
            }));
            expect(res.indexed.status, 'BET v0 create status').to.equal('valid');
            feedIndex = actionIndexOf(res);

            const feed = await getFeed(feedIndex);
            expect(feed, 'feed row exists').to.not.equal(null);
            expect(feed.feed_status, 'a fresh feed is open').to.equal('open');
            expect(feed.outcomes, 'canonical comma-joined outcomes').to.equal('Yes,No');
            expect(feed.tick, 'wager tick').to.equal(tickE1);
            // FEE is a PERCENT and round-trips through bignumber, so '1.00' stores
            // normalized as '1'. Assert the value, not the formatting: §7 divides by
            // 100 either way and zero-padding is a display concern.
            amtEq(feed.fee, '1', 'fee is one percent');
            expect(Number(feed.deadline), 'deadline stored').to.equal(deadline);
            // expire_at is materialized at parse so the bounded expiry pass can index it.
            expect(Number(feed.expire_at), 'expire_at = deadline + refund_window')
                .to.equal(deadline + MIN_REFUND_WINDOW);
            expect(feed.closed_block, 'not latched yet').to.equal(null);
            expect(feed.terminal_block, 'not terminal yet').to.equal(null);
            expect(feed.details, 'DETAILS rides the chain as base64').to.be.a('string').and.not.equal('');
        });

        it('accepts three bets across two outcomes and escrows every stake', async function () {
            await place(p1, feedIndex, 0, '10.00000000');
            await place(p2, feedIndex, 1, '5.00000000');
            await place(p3, feedIndex, 0, '2.50000000');

            const rows = await getBets(feedIndex);
            expect(rows.length, 'three bet rows').to.equal(3);
            expect(rows.map(r => r.bet_status), 'all open before settlement')
                .to.deep.equal(['open', 'open', 'open']);
            // Stakes are debited + escrowed at place time: spendable balance is zero.
            for (const who of [p1, p2, p3])
                amtEq(await balanceOf(who.address, tickE1), '0', 'stake escrowed out of spendable balance');
        });

        it('latches the feed closed once a block crosses the deadline', async function () {
            oracleBefore = await balanceOf(oracle.address, tickE1);

            await jumpTo(deadline + 60, 2);
            const feed = await waitFeedStatus(feedIndex, 'closed');

            expect(feed.feed_status, 'feed latched closed at the deadline').to.equal('closed');
            expect(Number(feed.closed_block), 'closed_block stamped with the latching block')
                .to.be.greaterThan(0);
            expect(feed.terminal_block, 'the latch is not a terminal flip').to.equal(null);
        });

        it('settles to the worked example exactly, with conservation', async function () {
            await resumeMiningAtFrozenClock();
            const res = await submitBet(sdk, oracle, sdk.betting.resolveMarketParams({
                feedActionIndex: feedIndex, outcome: 0
            }));
            expect(res.indexed.status, 'BET v3 resolve status').to.equal('valid');

            const feed = await getFeed(feedIndex);
            expect(feed.feed_status, 'feed resolved').to.equal('resolved');
            expect(Number(feed.terminal_block), 'terminal_block stamped').to.be.greaterThan(0);

            amtEq(await balanceOf(p1.address, tickE1), '13.86', "A's payout");
            amtEq(await balanceOf(p3.address, tickE1), '3.465', "C's payout");
            amtEq(await balanceOf(p2.address, tickE1), '0',     'B backed the loser');

            const oracleAfter = await balanceOf(oracle.address, tickE1);
            amtEq(Number(oracleAfter) - Number(oracleBefore), '0.175',
                'oracle cut = fee 0.175 + dust 0');

            const rows = await getBets(feedIndex);
            const by = Object.fromEntries(rows.map(r => [r.source, r]));
            expect(by[p1.address].bet_status, 'A won').to.equal('won');
            expect(by[p3.address].bet_status, 'C won').to.equal('won');
            expect(by[p2.address].bet_status, 'B lost').to.equal('lost');
            // A feed in a terminal status has ZERO open bets by construction (§7);
            // that is what makes the bet_status='open' pool predicate safe.
            expect(rows.filter(r => r.bet_status === 'open').length,
                'no bet left open on a terminal feed').to.equal(0);
            for (const r of rows)
                expect(Number(r.settled_block), `settled_block stamped for ${r.source}`).to.be.greaterThan(0);

            const out = Number(await balanceOf(p1.address, tickE1))
                      + Number(await balanceOf(p3.address, tickE1))
                      + (Number(oracleAfter) - Number(oracleBefore));
            amtEq(out, '17.5', 'sum(credits out) == sum(escrows in) == T');
        });
    });

    describe('E2: multiple bets from one address settle pro-rata per row', function () {

        it('credits each winning bet row independently', async function () {
            // No fee, so the pot is the whole T and the arithmetic stays exact.
            const { feedIndex, deadline } = await openMarket({
                outcomes: ['Home', 'Away'], tick: tickE2, fee: '0', label: 'E2 multi-bet pro-rata'
            });

            // p1 bets TWICE on the winner and once on the loser; p2 backs the loser.
            await place(p1, feedIndex, 0, '10.00000000');
            await place(p1, feedIndex, 0, '5.00000000');
            await place(p1, feedIndex, 1, '5.00000000');
            await place(p2, feedIndex, 1, '10.00000000');

            await closeAndResolve(feedIndex, deadline, 0);

            // T = 30, W = 15, fee = 0, pot = 30.
            // p1 row1 = floor(10 * 30 / 15) = 20; row2 = floor(5 * 30 / 15) = 10.
            // Her losing 5 is consumed. p1 staked her entire 20 balance, so the
            // final balance IS the payout: 30.
            const rows = await getBets(feedIndex);
            expect(rows.length, 'four bet rows').to.equal(4);
            const statuses = rows.map(r => r.bet_status);
            expect(statuses.filter(s => s === 'won').length, 'two winning rows').to.equal(2);
            expect(statuses.filter(s => s === 'lost').length, 'two losing rows').to.equal(2);

            amtEq(await balanceOf(p1.address, tickE2), '30',
                'two winning rows paid 20 + 10 separately; the losing 5 was consumed');
            amtEq(await balanceOf(p2.address, tickE2), '0', 'p2 backed the loser');

            const feed = await getFeed(feedIndex);
            expect(feed.feed_status, 'feed resolved').to.equal('resolved');
            expect(rows.filter(r => r.bet_status === 'open').length, 'nothing left open').to.equal(0);
        });
    });

    describe('E3: resolving to an unbacked outcome voids and refunds in full', function () {

        it('refunds every stake, takes NO fee, and marks the feed resolved_void', async function () {
            // Three outcomes; all money sits on 0 and 1, so resolving to 2 gives W = 0.
            const { feedIndex, deadline } = await openMarket({
                outcomes: ['Red', 'Green', 'Blue'], tick: tickE3, fee: '5.00', label: 'E3 void refund'
            });

            await place(p1, feedIndex, 0, '7.00000000');
            await place(p2, feedIndex, 1, '3.00000000');

            const oracleBefore = await balanceOf(oracle.address, tickE3);
            await closeAndResolve(feedIndex, deadline, 2);

            const feed = await getFeed(feedIndex);
            expect(feed.feed_status, 'nobody backed the winner').to.equal('resolved_void');
            expect(Number(feed.terminal_block), 'terminal_block stamped').to.be.greaterThan(0);

            amtEq(await balanceOf(p1.address, tickE3), '7', 'p1 refunded in full');
            amtEq(await balanceOf(p2.address, tickE3), '3', 'p2 refunded in full');
            // Decision E: a void is not a payday, even on a feed that set FEE=5%.
            amtEq(Number(await balanceOf(oracle.address, tickE3)) - Number(oracleBefore), '0',
                'NO fee is taken on a void');

            const rows = await getBets(feedIndex);
            expect(rows.map(r => r.bet_status), 'both rows refunded')
                .to.deep.equal(['refunded', 'refunded']);
            expect(rows.filter(r => r.bet_status === 'open').length, 'nothing left open').to.equal(0);
        });
    });

    describe('E10: the rake case, including a payout that floors to zero', function () {

        it('rakes when W == T and absorbs a zero-floored winner into dust', async function () {
            // Everyone backs the SAME outcome, so W == T and the fee comes straight
            // out of the winners: standard parimutuel rake, intended behaviour.
            const { feedIndex, deadline } = await openMarket({
                outcomes: ['Yes', 'No'], tick: tickE10, fee: '1.00', label: 'E10 rake + zero-floor'
            });

            await place(p1, feedIndex, 0, '10.00000000');
            await place(p2, feedIndex, 0, '0.00000001');

            const oracleBefore = await balanceOf(oracle.address, tickE10);
            await closeAndResolve(feedIndex, deadline, 0);

            // T = W = 10.00000001
            // fee = floor(10.00000001 * 1/100, 8) = 0.10000000
            // pot = 9.90000001
            // p1  = floor(10 * 9.90000001 / 10.00000001, 8) = 9.90000000  <- a net LOSS
            //       on a WINNING bet: the rake. Wallets must project payouts so this
            //       is never a surprise.
            // p2  = floor(0.00000001 * 9.90000001 / 10.00000001, 8) = 0   <- zero-floor
            // paid = 9.9, dust = 0.00000001, oracle = fee + dust = 0.10000001
            amtEq(await balanceOf(p1.address, tickE10), '9.9',
                'a winning stake nets a loss to the rake (pot < W)');
            amtEq(await balanceOf(p2.address, tickE10), '0',
                'a one-base-unit winning stake floors to a zero payout: no credit row');
            amtEq(Number(await balanceOf(oracle.address, tickE10)) - Number(oracleBefore), '0.10000001',
                'oracle receives fee 0.1 PLUS the zero-floored dust 0.00000001');

            // The zero-floored bet still WON. It simply earned nothing, and the amount
            // was absorbed into dust rather than silently dropped.
            const rows = await getBets(feedIndex);
            const by = Object.fromEntries(rows.map(r => [r.source, r]));
            expect(by[p1.address].bet_status, 'p1 won').to.equal('won');
            expect(by[p2.address].bet_status,
                'a zero-floored payout is still a WIN, not a loss').to.equal('won');
            expect(rows.filter(r => r.bet_status === 'open').length, 'nothing left open').to.equal(0);

            const out = Number(await balanceOf(p1.address, tickE10))
                      + Number(await balanceOf(p2.address, tickE10))
                      + (Number(await balanceOf(oracle.address, tickE10)) - Number(oracleBefore));
            amtEq(out, '10.00000001', 'sum(credits out) == sum(escrows in) == T');
        });
    });
});
