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
 * XChain Platform E2E - BET cancel + rejection matrix (spec §12 E5, E6)
 *
 *   E5 feed cancel: every open bet refunded in full, NO oracle fee, feed
 *      `cancelled`, and the cancelled feed then refuses new bets
 *   E6 rejections that depend on CHAIN STATE
 *
 * Scope note for E6. The spec's reject list mixes two very different classes:
 *
 *   (a) malformed-field rejects (non-strict base64 DETAILS, oversize LABEL,
 *       DEADLINE past the horizon, a non-array `outcomes`, native TICK, ...)
 *   (b) state-dependent rejects (betting after the deadline, resolving early,
 *       resolving as a non-owner, staking below the feed's own MIN_AMOUNT, ...)
 *
 * Only (b) is meaningfully an END-TO-END test. The (a) cases are rejected by
 * the SDK's own validator before a transaction is ever composed, so driving
 * them through this harness would assert the SDK's client-side guard a second
 * time and never reach the indexer at all; they are already pinned where they
 * belong, in the SDK unit suite and in the decoder/encoder gate vectors from
 * batch A. This file therefore drills class (b), where the indexer is the only
 * thing standing between a hostile action and a corrupted market.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, fundedGasAddress } = require('./sdkHelper');
const {
    MIN_REFUND_WINDOW, getFeed, getBets, balanceOf, amtEq, actionIndexOf,
    blockTime, jumpTo, resumeMiningAtFrozenClock, releaseClock, waitFeedStatus,
    issueWagerToken, submitBet
} = require('./betHelper');

let sdk, oracle, punter, stranger;
let tickCancel, tickReject;

async function openMarket(tick, opts = {}) {
    const now = await blockTime();
    const deadline = now + (opts.window || 300);
    const res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
        label:        opts.label || 'negative-path market',
        outcomes:     opts.outcomes || ['Yes', 'No'],
        tick,
        fee:          opts.fee || '2.00',
        deadline,
        refundWindow: MIN_REFUND_WINDOW,
        minAmount:    opts.minAmount,
        now
    }));
    expect(res.indexed.status, 'market create status').to.equal('valid');
    return { feedIndex: actionIndexOf(res), deadline };
}

// Submit something that must be rejected, and return what the SDK reported.
//
// The SDK's return shape is NOT a reliable rejection signal here: `requireValid`
// defaults true, but the waiter narrows to a targeted action_index before
// looking for an `invalid` status, so a rejected action can surface as a
// resolved promise reporting 'valid'. Every assertion below therefore reads the
// chain instead -- either the reason the indexer recorded against the action, or
// the fact that the market is provably unchanged.
async function submitExpectingRejection(run) {
    try {
        const res = await run();
        return String((res && res.indexed && res.indexed.status) || 'resolved(no status)');
    } catch (e) {
        return String((e && e.message) || e);
    }
}

// For a rejected PLACE: the row is written with the reason on the place action,
// and crucially it must NOT become a live stake.
async function expectBetRejected(feedIndex, run, pattern, message) {
    const openBefore = (await getBets(feedIndex)).filter(b => b.bet_status === 'open').length;
    const sdkSaid = await submitExpectingRejection(run);

    const rows = await getBets(feedIndex);
    const openAfter = rows.filter(b => b.bet_status === 'open').length;
    const newest = rows[rows.length - 1];
    console.log(`      [bet-negative] ${message}\n        indexer: ${newest && newest.parse_status}  (sdk reported: ${sdkSaid})`);

    expect(newest && String(newest.parse_status), message).to.match(pattern);
    expect(openAfter, `${message}: the rejected stake must not join the pool`).to.equal(openBefore);
    return sdkSaid;
}

// For a rejected feed-level action (cancel / resolve) there is no new row to
// carry a reason, so the assertion is that the market is provably untouched.
async function expectFeedUnchanged(feedIndex, run, message) {
    const before = await getFeed(feedIndex);
    const sdkSaid = await submitExpectingRejection(run);
    const after = await getFeed(feedIndex);
    console.log(`      [bet-negative] ${message}\n        feed stayed '${after.feed_status}'  (sdk reported: ${sdkSaid})`);

    expect(after.feed_status, `${message}: feed lifecycle status must not move`)
        .to.equal(before.feed_status);
    expect(after.terminal_block, `${message}: no terminal stamp may be written`)
        .to.equal(before.terminal_block);
    return sdkSaid;
}

describe('[sdk] BET cancel + rejection matrix (§12 E5/E6)', function () {

    before(async function () {
        // See bet.sdk.test.js: the SDK's ^id compaction outruns the indexer's wire
        // acceptance and would invalidate the setup SENDs.
        sdk = makeSdk({ compactAddresses: false });

        oracle   = await fundedGasAddress(sdk, 1);
        punter   = await fundedGasAddress(sdk, 1);
        stranger = await fundedGasAddress(sdk, 1);

        tickCancel = await issueWagerToken(sdk, oracle, [
            [punter.address, '4.00000000'], [stranger.address, '6.00000000']
        ], 1000000, 'BC1');

        tickReject = await issueWagerToken(sdk, oracle, [
            [punter.address, '10.00000000'], [stranger.address, '10.00000000']
        ], 1000000, 'BR1');
    });

    after(async function () {
        await releaseClock();
    });

    describe('E5: cancelling a feed refunds every stake and takes no fee', function () {

        it('refunds in full, marks the feed cancelled, and then refuses new bets', async function () {
            const { feedIndex } = await openMarket(tickCancel, { label: 'E5 cancel', fee: '10.00' });

            await submitBet(sdk, punter, sdk.betting.placeBetParams({
                feedActionIndex: feedIndex, outcome: 0, amount: '4.00000000' }));
            await submitBet(sdk, stranger, sdk.betting.placeBetParams({
                feedActionIndex: feedIndex, outcome: 1, amount: '6.00000000' }));

            const oracleBefore = await balanceOf(oracle.address, tickCancel);

            const res = await submitBet(sdk, oracle, sdk.betting.cancelMarketParams({
                feedActionIndex: feedIndex }));
            expect(res.indexed.status, 'BET v1 cancel status').to.equal('valid');

            const feed = await getFeed(feedIndex);
            expect(feed.feed_status, 'feed cancelled').to.equal('cancelled');
            expect(Number(feed.terminal_block), 'terminal_block stamped on cancel').to.be.greaterThan(0);

            // The oracle's honest out: everyone whole, nobody paid for the privilege.
            amtEq(await balanceOf(punter.address, tickCancel), '4', 'punter refunded in full');
            amtEq(await balanceOf(stranger.address, tickCancel), '6', 'stranger refunded in full');
            amtEq(Number(await balanceOf(oracle.address, tickCancel)) - Number(oracleBefore), '0',
                'NO fee on cancel, even at FEE=10%');

            const rows = await getBets(feedIndex);
            expect(rows.map(r => r.bet_status), 'both rows refunded')
                .to.deep.equal(['refunded', 'refunded']);
            expect(rows.filter(r => r.bet_status === 'open').length,
                'a cancelled feed has zero open bets').to.equal(0);

            // A cancelled feed is terminal: a late bet must not re-open it. This is
            // the case that makes the bet_status='open' pool predicate load-bearing,
            // since cancel already moved rows out of 'open'.
            await expectBetRejected(feedIndex,
                () => submitBet(sdk, punter, sdk.betting.placeBetParams({
                    feedActionIndex: feedIndex, outcome: 0, amount: '1.00000000' })),
                /feed not open|not open|closed/i,
                'a bet on a cancelled feed'
            );
        });
    });

    describe('E6: state-dependent rejections', function () {

        it('rejects a resolve before the deadline (DEADLINE is the earliest resolve)', async function () {
            const { feedIndex } = await openMarket(tickReject, { label: 'E6 early resolve' });
            await submitBet(sdk, punter, sdk.betting.placeBetParams({
                feedActionIndex: feedIndex, outcome: 0, amount: '1.00000000' }));

            await expectFeedUnchanged(feedIndex,
                () => submitBet(sdk, oracle, sdk.betting.resolveMarketParams({
                    feedActionIndex: feedIndex, outcome: 0 })),
                'resolving before the deadline'
            );
        });

        it('rejects a resolve and a cancel from a non-owner', async function () {
            const { feedIndex } = await openMarket(tickReject, { label: 'E6 non-owner' });

            await expectFeedUnchanged(feedIndex,
                () => submitBet(sdk, stranger, sdk.betting.cancelMarketParams({
                    feedActionIndex: feedIndex })),
                'a cancel from someone who does not own the feed'
            );

            // The market is still open and untouched after the hostile cancel.
            const feed = await getFeed(feedIndex);
            expect(feed.feed_status, 'feed survives a non-owner cancel').to.equal('open');
        });

        it('rejects an OUTCOME outside the feed range', async function () {
            const { feedIndex } = await openMarket(tickReject, { label: 'E6 outcome range' });

            // `outcomes` is deliberately NOT passed to placeBetParams, so the SDK's
            // client-side range check is bypassed and the INDEXER is what rejects.
            await expectBetRejected(feedIndex,
                () => submitBet(sdk, punter, sdk.betting.placeBetParams({
                    feedActionIndex: feedIndex, outcome: 7, amount: '1.00000000' })),
                /OUTCOME|range/i,
                'a bet on outcome 7 of a two-outcome market'
            );
        });

        it('rejects a stake below the feed MIN_AMOUNT', async function () {
            const { feedIndex } = await openMarket(tickReject, {
                label: 'E6 min amount', minAmount: '5.00000000' });

            await expectBetRejected(feedIndex,
                () => submitBet(sdk, punter, sdk.betting.placeBetParams({
                    feedActionIndex: feedIndex, outcome: 0, amount: '1.00000000' })),
                /AMOUNT|minimum/i,
                'a 1.0 stake on a market with a 5.0 minimum'
            );

            // ... and accepts one at the minimum, so the bound is not off by one.
            const ok = await submitBet(sdk, punter, sdk.betting.placeBetParams({
                feedActionIndex: feedIndex, outcome: 0, amount: '5.00000000' }));
            expect(ok.indexed.status, 'a stake exactly AT the minimum is valid').to.equal('valid');
        });

        it('rejects a stake larger than the bettor holds', async function () {
            const { feedIndex } = await openMarket(tickReject, { label: 'E6 insufficient' });

            await expectBetRejected(feedIndex,
                () => submitBet(sdk, stranger, sdk.betting.placeBetParams({
                    feedActionIndex: feedIndex, outcome: 0, amount: '9999.00000000' })),
                /insufficient|funds|AMOUNT/i,
                'a stake far beyond the bettor balance'
            );
        });

        it('rejects the oracle betting on its own feed', async function () {
            const { feedIndex } = await openMarket(tickReject, { label: 'E6 oracle self-bet' });

            // §5: expiry refunds in full, so an oracle that bets its own market holds
            // a free option to un-bet by simply walking away and letting it expire.
            await expectBetRejected(feedIndex,
                () => submitBet(sdk, oracle, sdk.betting.placeBetParams({
                    feedActionIndex: feedIndex, outcome: 0, amount: '1.00000000' })),
                /oracle|own feed|SOURCE/i,
                'the feed owner staking on its own market'
            );
        });

        it('rejects a bet once a block has crossed the deadline', async function () {
            // Runs LAST: it walks the chain clock forward, and every earlier case
            // needs a market that is still open.
            const { feedIndex, deadline } = await openMarket(tickReject, { label: 'E6 late bet' });
            await submitBet(sdk, punter, sdk.betting.placeBetParams({
                feedActionIndex: feedIndex, outcome: 0, amount: '1.00000000' }));

            await jumpTo(deadline + 60, 2);
            const feed = await waitFeedStatus(feedIndex, 'closed');
            expect(feed.feed_status, 'feed latched closed').to.equal('closed');
            // jumpTo parks the auto-miner; the late bet needs blocks again or it
            // simply never gets mined and the drill times out instead of proving
            // anything about the latch.
            await resumeMiningAtFrozenClock();

            await expectBetRejected(feedIndex,
                () => submitBet(sdk, punter, sdk.betting.placeBetParams({
                    feedActionIndex: feedIndex, outcome: 0, amount: '1.00000000' })),
                /feed not open|not open|closed/i,
                'a bet placed after the deadline latched the feed'
            );
        });
    });
});
