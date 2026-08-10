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
 * XChain Platform E2E - BET interaction with SWEEP and DIVIDEND (§12 E13, E14)
 *
 * E13 SWEEP (v0 rule, §5). Bets are a FOURTH escrow category, and the
 * ORDERS/SWAPS/DISPENSERS sweep flags deliberately do not cover them. So a
 * SWEEP moves the spendable balance but leaves the bet escrow where it is, does
 * not transfer the feed-operator role, and every later refund or payout credits
 * the ORIGINAL bet source. This is a documented limitation rather than an
 * oversight (sweep before betting, or accept that bet credits land on the old
 * address), which makes it exactly the kind of rule that rots silently unless a
 * drill pins it.
 *
 * E14 DIVIDEND. Escrowed stakes are EXCLUDED from distributions, and bets
 * inherit that for free: an escrow pushes a matching debits+escrows pair, and
 * `db.getHolders` computes SUM(credits) - SUM(debits) without ever reading the
 * escrows table, so escrowed tokens simply are not held for distribution
 * purposes. The spec asks for the EXCLUSION to be asserted directly rather than
 * for mere parity with orders, so this drill pays a dividend across two holders
 * whose only difference is that one has staked, and shows the staked one
 * receives nothing.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, submitOpts, fundedGasAddress } = require('./sdkHelper');
const {
    MIN_REFUND_WINDOW, getFeed, getBets, balanceOf, escrowOf, amtEq, actionIndexOf,
    blockTime, jumpTo, resumeMiningAtFrozenClock, releaseClock, waitFeedStatus,
    issueWagerToken, submitBet
} = require('./betHelper');

let sdk;
let oracleS, bettorX, bettorZ, sweepDest, oracleSDest, tickSweep;
let oracleD, holderY, bettorW, tickDiv, payoutTick;

// An address with no funding: only ever used as a SWEEP destination.
function plainAddress() {
    const kp = sdk.generateKeyPair();
    return { ...kp, address: sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' }) };
}

async function openMarket(oracle, tick, label) {
    const now = await blockTime();
    const deadline = now + 300;
    const res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
        label, outcomes: ['Yes', 'No'], tick, fee: '0', deadline,
        refundWindow: MIN_REFUND_WINDOW, now
    }));
    expect(res.indexed.status, `${label}: create status`).to.equal('valid');
    return { feedIndex: actionIndexOf(res), deadline };
}

describe('[sdk] BET interaction with SWEEP and DIVIDEND (§12 E13/E14)', function () {

    before(async function () {
        // See bet.sdk.test.js: ^id compaction outruns the indexer's wire acceptance.
        sdk = makeSdk({ compactAddresses: false });

        oracleS  = await fundedGasAddress(sdk, 1);
        bettorX  = await fundedGasAddress(sdk, 1);
        bettorZ  = await fundedGasAddress(sdk, 1);
        sweepDest   = plainAddress();
        oracleSDest = plainAddress();

        // bettorX is funded with MORE than they stake, so the sweep has something
        // spendable to move and the escrow is visibly left behind.
        tickSweep = await issueWagerToken(sdk, oracleS, [
            [bettorX.address, '12.00000000'],
            [bettorZ.address, '5.00000000']
        ], 1000000, 'B13');

        oracleD = await fundedGasAddress(sdk, 1);
        holderY = await fundedGasAddress(sdk, 1);
        bettorW = await fundedGasAddress(sdk, 1);

        // holderY and bettorW hold the SAME amount; the only difference will be
        // that bettorW stakes theirs.
        tickDiv = await issueWagerToken(sdk, oracleD, [
            [holderY.address, '10.00000000'],
            [bettorW.address, '10.00000000']
        ], 1000000, 'B14');

        // A separate token to pay the dividend in.
        payoutTick = await issueWagerToken(sdk, oracleD, [], 1000000, 'B14P');
    });

    after(async function () {
        await releaseClock();
    });

    it('E13: SWEEP moves the spendable balance but not the bet escrow, and payouts credit the ORIGINAL source', async function () {
        const { feedIndex, deadline } = await openMarket(oracleS, tickSweep, 'E13 sweep');

        const x = await submitBet(sdk, bettorX, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount: '10.00000000' }));
        expect(x.indexed.status, 'bettorX stakes 10 of their 12').to.equal('valid');
        const z = await submitBet(sdk, bettorZ, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 1, amount: '5.00000000' }));
        expect(z.indexed.status, 'bettorZ backs the loser').to.equal('valid');

        amtEq(await balanceOf(bettorX.address, tickSweep), '2', 'bettorX keeps 2 spendable');
        amtEq(await escrowOf(bettorX.address, tickSweep), '10', 'bettorX has 10 escrowed');

        // Sweep the bettor. balances=1 moves what is spendable; the escrow is a
        // category SWEEP does not touch in v0.
        const sweepX = await submit(sdk,
            { action: 'SWEEP', params: { destination: sweepDest.address, balances: 1 } },
            { pubkey: bettorX.address, change: bettorX.address },
            submitOpts({ wif: bettorX.wif }));
        expect(sweepX.indexed.status, 'the bettor sweep is valid').to.equal('valid');

        amtEq(await balanceOf(sweepDest.address, tickSweep), '2',
            'the SPENDABLE 2 moved to the sweep destination');
        amtEq(await balanceOf(bettorX.address, tickSweep), '0', 'bettorX is swept clean');
        amtEq(await escrowOf(bettorX.address, tickSweep), '10',
            'the 10 in escrow did NOT move: bets are a fourth escrow category');

        // Sweep the ORACLE too, balances and ownerships. The feed-operator role is
        // not an ownership SWEEP transfers, so the swept key must still resolve.
        const sweepO = await submit(sdk,
            { action: 'SWEEP', params: { destination: oracleSDest.address, balances: 1, ownerships: 1 } },
            { pubkey: oracleS.address, change: oracleS.address },
            submitOpts({ wif: oracleS.wif }));
        expect(sweepO.indexed.status, 'the oracle sweep is valid').to.equal('valid');

        await jumpTo(deadline + 60, 2);
        await waitFeedStatus(feedIndex, 'closed');
        await resumeMiningAtFrozenClock();

        const resolve = await submitBet(sdk, oracleS, sdk.betting.resolveMarketParams({
            feedActionIndex: feedIndex, outcome: 0 }));
        expect(resolve.indexed.status,
            'a SWEPT oracle key must still be able to resolve its own feed').to.equal('valid');
        expect((await getFeed(feedIndex)).feed_status, 'feed resolved').to.equal('resolved');

        // T=15, W=10, fee=0, pot=15 -> bettorX = floor(10 * 15 / 10) = 15.
        // It lands on the ORIGINAL bet source, NOT the sweep destination.
        amtEq(await balanceOf(bettorX.address, tickSweep), '15',
            'the payout credits the ORIGINAL bet source');
        amtEq(await balanceOf(sweepDest.address, tickSweep), '2',
            'the sweep destination received nothing from the settlement');
        amtEq(await escrowOf(bettorX.address, tickSweep), '0',
            'the escrow is released by settlement, not by the sweep');

        const rows = await getBets(feedIndex);
        expect(rows.find(r => r.source === bettorX.address).bet_status, 'bettorX won').to.equal('won');
    });

    it('E14: a dividend skips escrowed stakes entirely', async function () {
        const { feedIndex, deadline } = await openMarket(oracleD, tickDiv, 'E14 dividend');

        // bettorW stakes their whole balance; holderY simply holds an identical
        // amount. That is the ONLY difference between them.
        const w = await submitBet(sdk, bettorW, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount: '10.00000000' }));
        expect(w.indexed.status, 'bettorW stakes everything').to.equal('valid');

        amtEq(await balanceOf(bettorW.address, tickDiv), '0', 'bettorW holds nothing spendable');
        amtEq(await escrowOf(bettorW.address, tickDiv), '10', 'bettorW has 10 escrowed');
        amtEq(await balanceOf(holderY.address, tickDiv), '10', 'holderY still holds 10');

        // Pay 1 unit of payoutTick per unit of tickDiv held.
        const div = await submit(sdk,
            { action: 'DIVIDEND', params: { tick: tickDiv, dividendTick: payoutTick, amount: 1 } },
            { pubkey: oracleD.address, change: oracleD.address },
            submitOpts({ wif: oracleD.wif }));
        expect(div.indexed.status, 'DIVIDEND status').to.equal('valid');

        // getHolders is credits-minus-debits and never reads the escrows table, so
        // an escrowed stake is simply not held for distribution purposes.
        amtEq(await balanceOf(holderY.address, payoutTick), '10',
            'the plain holder receives 1 per unit held');
        amtEq(await balanceOf(bettorW.address, payoutTick), '0',
            'the bettor receives NOTHING: their stake is escrowed, so they hold nothing');

        // And the stake is untouched by the dividend: it still settles normally.
        await jumpTo(deadline + 60, 2);
        await waitFeedStatus(feedIndex, 'closed');
        await resumeMiningAtFrozenClock();

        const resolve = await submitBet(sdk, oracleD, sdk.betting.resolveMarketParams({
            feedActionIndex: feedIndex, outcome: 0 }));
        expect(resolve.indexed.status, 'resolve status').to.equal('valid');

        // Sole bettor, FEE=0: the whole pot returns.
        amtEq(await balanceOf(bettorW.address, tickDiv), '10',
            'the escrowed stake settles back in full, undisturbed by the dividend');
        amtEq(await escrowOf(bettorW.address, tickDiv), '0', 'escrow released');
        amtEq(await balanceOf(bettorW.address, payoutTick), '0',
            'settling later does NOT retroactively earn the missed dividend');
    });
});
