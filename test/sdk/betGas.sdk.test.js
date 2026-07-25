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
 * XChain Platform E2E - BET gas schedule (spec §12 E9, decision F)
 *
 * Feed creation is DURATION-priced on the ORDER/DISPENSER expiration mechanism
 * rather than a flat fee, so short-lived markets and anyone kicking the tyres
 * create for nothing and only long-lived feeds pay:
 *
 *     fee = (days - UNIFIED_EXPIRATION_FEE_FREE_DAYS) x BET_FEED_PER_DAY x GAS_PRICE
 *
 * measured on `expire_at - BLOCK_TIME` (the feed's full pass-eligible life, NOT
 * DEADLINE). With the shipped BTC schedule -- free window 90 days,
 * BET_FEED_PER_DAY 550, GAS_PRICE 0.00001 -- that is the §10 value table
 * asserted below. BET_PER_CREDIT (100 gas = 0.001 XCHAIN) is charged at PLACE,
 * which is what pre-funds the free system-injected expiry pass; resolve and
 * cancel are free, because a resolve surcharge would be griefable by dust bets.
 *
 * THE CONSENSUS TRAP this drill exists to pin: the day count is
 * bcdiv(seconds, 86400, 0), and mathjs ROUNDS TO NEAREST rather than flooring.
 * An implementer reaching for bcfloor/Math.floor forks from ORDER at every
 * fractional-day boundary. The 90.4-day and 90.6-day cases below pin that from
 * both sides: a floor would make 90.6 days free, a ceil would make 90.4 days
 * chargeable, and only round-to-nearest gives free/charged respectively.
 *
 * Assertions read `fees.xchain_amount` (gas x GAS_PRICE) rather than a balance
 * delta, so they hold under BOTH payment modes (native coin and XCHAIN
 * balance). ORDER byte-identity for the shared arithmetic is pinned at unit
 * level in xchain-indexer/test/unit/bet-duration-fee.test.js.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, fundedGasAddress } = require('./sdkHelper');
const {
    MIN_REFUND_WINDOW, dbQuery, getFeed, amtEq, actionIndexOf, blockTime,
    jumpTo, resumeMiningAtFrozenClock, releaseClock, waitFeedStatus,
    issueWagerToken, submitBet
} = require('./betHelper');

const DAY = 86400;
const MAX_DEADLINE_HORIZON = 31536000;   // 1 year
const MAX_REFUND_WINDOW    = 31536000;   // 1 year

let sdk, oracle, punter, tick;

// The protocol fee charged for an action, in XCHAIN, as the indexer recorded
// it. A zero-fee action may write no row at all, which reads as '0'.
async function xchainFeeOf(actionIndex) {
    const rows = await dbQuery(
        'SELECT xchain_amount, gas_cost, payment_mode, fee_version FROM fees WHERE action_index = ?',
        [actionIndex]);
    return rows.length ? String(rows[0].xchain_amount || '0') : '0';
}

// Open a feed whose FULL pass-eligible life (expire_at - BLOCK_TIME) is
// `durationSeconds`. Both the deadline offset and the refund window are capped
// at one year each, so a 730-day feed is built by maxing out both.
async function openWithDuration(durationSeconds, label) {
    const now = await blockTime();

    let refundWindow, deadlineOffset;
    if (durationSeconds <= MAX_DEADLINE_HORIZON + MIN_REFUND_WINDOW) {
        refundWindow   = MIN_REFUND_WINDOW;
        deadlineOffset = durationSeconds - MIN_REFUND_WINDOW;
    } else {
        deadlineOffset = MAX_DEADLINE_HORIZON;
        refundWindow   = durationSeconds - MAX_DEADLINE_HORIZON;
        expect(refundWindow, `${label}: refund window within protocol max`).to.be.at.most(MAX_REFUND_WINDOW);
    }

    const deadline = now + deadlineOffset;
    const res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
        label, outcomes: ['Yes', 'No'], tick, fee: '1.00',
        deadline, refundWindow, now
    }));
    expect(res.indexed.status, `${label}: create status`).to.equal('valid');

    const feedIndex = actionIndexOf(res);
    const feed = await getFeed(feedIndex);
    // Sanity: the stored life is what we asked for, within the couple of seconds
    // the block clock creeps between reading the tip and the tx being mined.
    const storedLife = Number(feed.expire_at) - now;
    expect(Math.abs(storedLife - durationSeconds),
        `${label}: stored expire_at reflects the requested duration`).to.be.at.most(5);

    return feedIndex;
}

describe('[sdk] BET gas schedule (§12 E9, decision F)', function () {

    before(async function () {
        // See bet.sdk.test.js: ^id compaction outruns the indexer's wire acceptance.
        sdk = makeSdk({ compactAddresses: false });
        oracle = await fundedGasAddress(sdk, 1);
        punter = await fundedGasAddress(sdk, 1);
        tick = await issueWagerToken(sdk, oracle, [[punter.address, '5.00000000']], 1000000, 'BG9');
    });

    after(async function () {
        await releaseClock();
    });

    it('creates for ZERO inside the 90-day free window', async function () {
        const feedIndex = await openWithDuration(44 * DAY, 'E9 free window 44d');
        amtEq(await xchainFeeOf(feedIndex), '0',
            'a 44-day market is free: short feeds and users testing the system pay nothing');
    });

    it('matches the §10 value table past the free window', async function () {
        const table = [
            { days: 91,  expected: '0.0055'  },
            { days: 120, expected: '0.165'   },
            { days: 365, expected: '1.5125'  }
        ];
        for (const row of table) {
            const feedIndex = await openWithDuration(row.days * DAY, `E9 ${row.days}d`);
            amtEq(await xchainFeeOf(feedIndex), row.expected,
                `${row.days} days = (${row.days} - 90) x 550 x 0.00001 XCHAIN`);
        }
    });

    it('prices the both-maxima feed (730 days) at the top of the table', async function () {
        // DEADLINE horizon and REFUND_WINDOW are one year each, so 730 days is
        // the longest life the protocol can express.
        const feedIndex = await openWithDuration(730 * DAY, 'E9 730d both maxima');
        amtEq(await xchainFeeOf(feedIndex), '3.52',
            '730 days = (730 - 90) x 550 x 0.00001 XCHAIN, the maximum creation fee');
    });

    it('rounds the day count to NEAREST, not floor and not ceil', async function () {
        // 90.4 days -> 90 -> free. A ceil implementation would charge here.
        const under = await openWithDuration(Math.round(90.4 * DAY), 'E9 90.4d');
        amtEq(await xchainFeeOf(under), '0',
            '90.4 days rounds DOWN to 90 and stays inside the free window');

        // 90.6 days -> 91 -> charged. A floor implementation (the natural
        // reach, and the fork this pins) would make this free.
        const over = await openWithDuration(Math.round(90.6 * DAY), 'E9 90.6d');
        amtEq(await xchainFeeOf(over), '0.0055',
            '90.6 days rounds UP to 91 and is charged: bcdiv rounds to nearest, it does not floor');
    });

    it('charges BET_PER_CREDIT at place, and nothing to cancel', async function () {
        const feedIndex = await openWithDuration(30 * DAY, 'E9 place + cancel');
        amtEq(await xchainFeeOf(feedIndex), '0', 'the 30-day feed itself is free');

        const bet = await submitBet(sdk, punter, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount: '5.00000000' }));
        expect(bet.indexed.status, 'place status').to.equal('valid');
        amtEq(await xchainFeeOf(actionIndexOf(bet)), '0.001',
            'a bet pre-funds its one terminal credit: BET_PER_CREDIT 100 gas x 0.00001');

        const cancel = await submitBet(sdk, oracle, sdk.betting.cancelMarketParams({
            feedActionIndex: feedIndex }));
        expect(cancel.indexed.status, 'cancel status').to.equal('valid');
        amtEq(await xchainFeeOf(actionIndexOf(cancel)), '0',
            'cancel is free regardless of bet count');
    });

    it('charges the duration fee AGAIN on cancel + recreate (no refund, no edit path)', async function () {
        const first = await openWithDuration(120 * DAY, 'E9 recreate first');
        amtEq(await xchainFeeOf(first), '0.165', 'first 120-day create charged');

        const cancel = await submitBet(sdk, oracle, sdk.betting.cancelMarketParams({
            feedActionIndex: first }));
        expect(cancel.indexed.status, 'cancel status').to.equal('valid');
        amtEq(await xchainFeeOf(actionIndexOf(cancel)), '0', 'cancelling refunds no gas');

        // Feeds are immutable from create; the fix path is cancel + recreate,
        // and it is deliberately NOT free.
        const second = await openWithDuration(120 * DAY, 'E9 recreate second');
        amtEq(await xchainFeeOf(second), '0.165',
            'recreating pays the duration fee a second time');
    });

    it('charges nothing to resolve, however many bets are on the book', async function () {
        const now = await blockTime();
        const deadline = now + 300;
        const res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
            label: 'E9 free resolve', outcomes: ['Yes', 'No'], tick, fee: '1.00',
            deadline, refundWindow: MIN_REFUND_WINDOW, now
        }));
        expect(res.indexed.status, 'create status').to.equal('valid');
        const feedIndex = actionIndexOf(res);

        await jumpTo(deadline + 60, 2);
        await waitFeedStatus(feedIndex, 'closed');
        await resumeMiningAtFrozenClock();

        const resolve = await submitBet(sdk, oracle, sdk.betting.resolveMarketParams({
            feedActionIndex: feedIndex, outcome: 0 }));
        expect(resolve.indexed.status, 'resolve status').to.equal('valid');
        amtEq(await xchainFeeOf(actionIndexOf(resolve)), '0',
            'resolve is free: a surcharge would be griefable by dust bets inflating the oracle cost');
    });
});
