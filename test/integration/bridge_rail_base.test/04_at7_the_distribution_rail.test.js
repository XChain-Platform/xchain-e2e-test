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
 *********************************************************************/

'use strict';

const {
    assert,
    chainRail,
    cryptoHelper,
    transactionHelper,
    mintHelper,
    lockWireV0,
    GAS_TICK,
    AT7_MINT,
    AT7_EACH,
    state,
    dogeAction,
    chainHalves,
    assertBacked,
    assertHubInvariantBacked,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

async function startDistributionLock() {
    // The ISSUE and the lock are both priced by the VENUE BTC indexer, off its own mirror.
    // Drive 18's lock of 30 "never finalized" because that indexer graded it `invalid: no
    // current oracle price for BTC/USD (missing or stale beyond 1800s)` 54 minutes after
    // bring-up (venue-logs-18/bridgerail-indexer0.log), so the federation never saw a
    // valid leg; the hub's `no broadcast pipeline` lines beside it were background noise.
    const reseed = await state.venue.refreshVenuePrices();
    state.evidence.at7_price = { reseed: reseed,
        btcMirror: await state.venue.readMirrorPrice('BTC', 'BTC/USD') };
    assert.ok(reseed && reseed.mirrors.BTC && reseed.mirrors.BTC.confirmed,
        'the BTC/USD and XCHAIN/USD reseed (round ' + (reseed ? reseed.round : 'none') +
        ') never reached the venue BTC indexer\'s mirror, so the ISSUE and lock below would be ' +
        'priced against ' + JSON.stringify(state.evidence.at7_price.btcMirror) + ': ' +
        JSON.stringify(reseed && reseed.mirrors));

    const operator = await state.venue.funded('AT7.OPERATOR', () => chainRail.withRail(state.dogeRail,
        () => cryptoHelper.getNewFundedAddress('AT7.OPERATOR', 'dogecoin', NETWORK, null, 'legacy', 0, 5, false)));
    const gasIssuer = await state.venue.funded('AT7.GAS',
        () => cryptoHelper.getNewFundedAddress('AT7.GAS', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));
    await mintHelper.sendMintV0(gasIssuer, GAS_TICK, AT7_MINT, gasIssuer.address, '');
    const lockTx = await transactionHelper.createAndSendTransaction(
        gasIssuer, lockWireV0('DOGE', operator.address, AT7_MINT, ''));
    const row = await state.venue.waitForFinalizedTransfer(
        (r) => String(r.dest_address) === operator.address && Number(r.amount) === AT7_MINT);
    return { operator, lockTx, row };
}

async function createRecipients() {
    const recipients = [];
    await chainRail.withRail(state.dogeRail, async () => {
        for (const label of ['AT7.R1', 'AT7.R2', 'AT7.R3']) {
            recipients.push(await cryptoHelper.getNewAddress(label, 'dogecoin', NETWORK, null, 'legacy', 0));
        }
    });
    return recipients;
}

// ── AT7 ────────────────────────────────────────────────────────────────────────
// BEFORE AT6, because AT6 ends by putting a permanent surplus of 1 on the rail and AT7
// asserts the invariant is equal. Section 15 writes AT6 as "after AT1 to AT5", which
// AT7 running in between does not disturb: every leg it adds is backed.
bridgeRailSuite('AT7: the distribution rail', function () {

    it('mints ' + AT7_MINT + ' on BTC, locks all of it and airdrops ' + AT7_EACH + ' to three DOGE addresses', async function () {
        this.timeout(0);
        if (needsFederation(this, 'AT7')) return;
        assert.ok(state.baseline, 'AT7 asserts an invariant reading, so the baseline case must have run');
        const { operator, lockTx, row } = await startDistributionLock();
        assert.ok(row, 'the AT7 lock of ' + AT7_MINT + ' never finalized.\n' + state.venue.hubTails(30));
        // The operator cannot airdrop units the destination has not credited yet.
        const applied = await state.venue.waitForBridgeApplied('DOGE', row.transfer_id);
        assert.ok(applied, 'the venue DOGE indexer never applied the AT7 lock ' + row.transfer_id +
            ', so the operator address holds nothing to distribute.\n' + state.venue.indexerTails(40));
        state.evidence.at7_appliedBlock = String(applied.block_index);

        const recipients = await createRecipients();

        // AIRDROP v0 IS `VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO` and LIST_ACTION_INDEX
        // is the action index of a prior type-2 (address) LIST, not a list of addresses.
        // Drive 7 passed the address array straight into the wire, the handler refused it
        // and the helper's waiting form reported "never landed at status=valid", which
        // reads as a bridge fault and was a wire-format fault.
        const list = await dogeAction(operator,
            'LIST|0|2||' + recipients.map((r) => r.address).join('|'), 'lists');
        state.evidence.at7_list = list;
        assert.strictEqual(list.status, 'valid',
            'the address LIST the airdrop distributes over was graded ' + list.status);

        const airdrop = await dogeAction(operator,
            'AIRDROP|0|' + GAS_TICK + '|' + AT7_EACH + '|' + list.actionIndex + '|', 'airdrops');
        state.evidence.at7_airdrop = airdrop;
        assert.strictEqual(airdrop.status, 'valid',
            'the AIRDROP of ' + AT7_EACH + ' ' + GAS_TICK + ' over list ' + list.actionIndex +
            ' was graded ' + airdrop.status + ' on the venue DOGE ledger');

        const landed = {};
        for (const r of recipients) landed[r.address] = await state.venue.addressBalance('DOGE', r.address, GAS_TICK);
        const inv = await state.venue.bridgeInvariant(GAS_TICK);
        const doge = inv[GAS_TICK].DOGE;
        const halves = await chainHalves();
        state.evidence.at7 = { lockTx, transferId: row.transfer_id, operator: operator.address, landed,
            dogeSupply: halves.supply, escrow: halves.escrow,
            nonBridgeEscrow: halves.nonBridge, backedByLocks: halves.backed,
            invariant: doge };

        // BY IDENTITY: each named recipient holds exactly its share. "Three addresses hold
        // 30 between them" is the assertion that passes when the split is wrong.
        for (const r of recipients) {
            assert.strictEqual(Number(landed[r.address]), AT7_EACH,
                r.address + ' holds ' + landed[r.address] + ' and not ' + AT7_EACH);
        }
        // The two chain halves, which is what "the invariant is equal" is a claim about,
        // and then the hub's own verdict held to the same identity: equal on a rail with no
        // stray SENDs, a surplus of exactly the measured non-bridge term on this one.
        assertBacked(halves, 'AT7');
        state.evidence.at7_hubReading = assertHubInvariantBacked(doge, halves, 'AT7');
        assert.strictEqual(String(doge.in_flight), '0');
    });
});
