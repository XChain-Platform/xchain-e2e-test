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
 * XChain Platform E2E - BET timestamp backdating (spec §12 E11)
 *
 * This drill is the reason the `closed` latch is STORED rather than recomputed
 * from the clock on every read, and it was the first finding of the adversarial
 * review pass.
 *
 * Block timestamps are not monotonic. A miner may stamp a block earlier than the
 * one before it, constrained only by median-time-past (the median of the last 11
 * blocks). So a betting market that decided "is this feed still open?" purely by
 * comparing BLOCK_TIME against DEADLINE would reopen the moment a block carried a
 * backdated timestamp: a miner who dislikes the result could stamp a block below
 * the deadline and slip in a bet AFTER the outcome is effectively known.
 *
 * The defence is that crossing the deadline writes a durable `closed` latch, and
 * format 2 requires BOTH `bet_status = open` AND `BLOCK_TIME < DEADLINE`. The
 * latch is one-way, so once any block has crossed the deadline no later block can
 * undo it, whatever timestamp it carries.
 *
 * This drill mines a genuinely backdated block to prove that. The rewind is
 * guarded: `backdateTo` refuses unless the target still clears median-time-past,
 * because a rewind below MTP forces bitcoind to stamp at MTP+1 and can wedge
 * block production for the whole stack. If the venue cannot host a legal
 * backdated block the drill SKIPS rather than risking that.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, submitOpts, fundedGasAddress } = require('./sdkHelper');
const {
    MIN_REFUND_WINDOW, getFeed, getBets, balanceOf, amtEq, actionIndexOf,
    blockTime, jumpTo, backdateTo, medianTimePast, mineAtFrozenClock,
    resumeMiningAtFrozenClock, releaseClock, waitFeedStatusNoMine, issueWagerToken,
    submitBet
} = require('./betHelper');

describe('[sdk] BET timestamp backdating (§12 E11)', function () {

    let sdk, oracle, punter, tick;

    before(async function () {
        // See bet.sdk.test.js: ^id compaction outruns the indexer's wire acceptance.
        sdk = makeSdk({ compactAddresses: false });
        oracle = await fundedGasAddress(sdk, 1);
        punter = await fundedGasAddress(sdk, 1);
        tick = await issueWagerToken(sdk, oracle, [[punter.address, '10.00000000']], 1000000, 'B11');
    });

    after(async function () {
        await releaseClock();
    });

    it('a backdated block cannot reopen betting on a latched feed', async function () {
        // A generous window, so the backdate target has room to sit comfortably
        // below DEADLINE and still above median-time-past.
        const now = await blockTime();
        const deadline = now + 3600;

        const res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
            label: 'E11 backdating', outcomes: ['Yes', 'No'], tick,
            fee: '1.00', deadline, refundWindow: MIN_REFUND_WINDOW, now
        }));
        expect(res.indexed.status, 'create status').to.equal('valid');
        const feedIndex = actionIndexOf(res);

        // An honest bet, comfortably before the deadline.
        const early = await submitBet(sdk, punter, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount: '4.00000000' }));
        expect(early.indexed.status, 'the honest pre-deadline bet is valid').to.equal('valid');

        // Cross the deadline: the end-of-block pass writes the one-way latch.
        await jumpTo(deadline + 120, 2);
        // NoMine: every extra block here would carry the jumped timestamp and drag
        // median-time-past above the deadline, making a legal backdate impossible.
        const latched = await waitFeedStatusNoMine(feedIndex, 'closed');
        expect(latched.feed_status, 'feed latched closed').to.equal('closed');
        expect(Number(latched.closed_block), 'closed_block stamped').to.be.greaterThan(0);

        // Now the attack: rewind the clock BELOW the deadline and mine there, so
        // the next block genuinely carries BLOCK_TIME < DEADLINE even though an
        // earlier block already crossed it.
        const target = deadline - 600;
        const rewind = await backdateTo(target);
        if (!rewind.ok) {
            console.log(`      [bet-backdate] SKIPPED: ${rewind.reason}`);
            this.skip();
            return;
        }
        console.log(`      [bet-backdate] backdated to ${target} (deadline ${deadline}, MTP ${rewind.mtp})`);

        let rejected;
        try {
            // Broadcast into the mempool, then seal the backdated block over it.
            await submit(sdk,
                { action: 'BET', params: sdk.betting.placeBetParams({
                    feedActionIndex: feedIndex, outcome: 1, amount: '6.00000000' }) },
                { pubkey: punter.address, change: punter.address },
                submitOpts({ wif: punter.wif, waitForIndexer: false }));
            await mineAtFrozenClock(1);
            await new Promise(r => setTimeout(r, 6000));

            // Confirm the block really was backdated, or the drill proves nothing.
            const minedAt = await blockTime();
            expect(minedAt, 'the mined block genuinely carries a pre-deadline timestamp')
                .to.be.lessThan(deadline);

            const rows = await getBets(feedIndex);
            rejected = rows.find(r => Number(r.action_index) !== Number(actionIndexOf(early)));
            expect(rejected, 'the backdated bet reached the chain and was recorded').to.not.equal(undefined);
            console.log(`      [bet-backdate] indexer: ${rejected.parse_status}`);
        } finally {
            // Put the clock back above every block the chain carries BEFORE the
            // suite ends, so nothing downstream inherits a sub-MTP clock.
            await releaseClock();
            await resumeMiningAtFrozenClock();
        }

        // THE assertion: rejected on the stored latch, not on the clock. A
        // clock-only implementation would have accepted this bet, because
        // BLOCK_TIME really is below DEADLINE in the block it landed in.
        expect(String(rejected.parse_status),
            'a backdated block must NOT reopen a latched feed').to.match(/feed not open|not open|closed/i);
        expect(rejected.bet_status, 'the backdated stake never became a live bet').to.not.equal('open');

        // And no escrow was taken: the punter still holds everything the honest
        // bet did not stake.
        amtEq(await balanceOf(punter.address, tick), '6',
            'the rejected bet took no escrow from the punter');

        const feed = await getFeed(feedIndex);
        expect(feed.feed_status, 'the feed is still closed, never reopened').to.equal('closed');
    });
});
