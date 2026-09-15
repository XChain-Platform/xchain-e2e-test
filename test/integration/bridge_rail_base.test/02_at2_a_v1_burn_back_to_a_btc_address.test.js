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
    burnWireV1,
    escrowOf,
    GAS_TICK,
    AT1_LOCK,
    AT2_BURN,
    state,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

async function startBurn(dest) {
    const burner = state.at1Dest.address;

    const before = {
        btcDest: await state.venue.addressBalance('BTC', dest.address, GAS_TICK),
        escrow: escrowOf(await state.venue.bridgeBalances('BTC', GAS_TICK), 'DOGE'),
        dogeSupply: (await state.venue.bridgeBalances('DOGE', GAS_TICK)).supply,
    };

    const burnTx = await chainRail.withRail(state.dogeRail, () =>
        transactionHelper.createAndSendTransaction(
            state.at1Dest, burnWireV1(dest.address, AT2_BURN, '')));
    state.evidence.at2_burnTx = burnTx;

    const row = await state.venue.waitForFinalizedTransfer(
        (r) => String(r.src_chain) === 'DOGE' && String(r.dest_chain) === 'BTC' &&
               String(r.dest_address) === dest.address);
    return { burner, before, row };
}

// ── AT2 ────────────────────────────────────────────────────────────────────────
bridgeRailSuite('AT2: a v1 burn of ' + AT2_BURN + ' back to a BTC address', function () {

    it('releases the escrow to the exact BTC address and lowers the DOGE supply', async function () {
        this.timeout(0);
        if (needsFederation(this, 'AT2')) return;

        const dest = await state.venue.funded('AT2.DEST',
            () => cryptoHelper.getNewFundedAddress('AT2.DEST', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));
        assert.ok(state.at1Dest, 'AT2 burns the units AT1 minted from the address AT1 named, so AT1 must ' +
            'have run and left its destination record');
        const { before, row } = await startBurn(dest);
        assert.ok(row, 'no bridge_transfers row for the burn to ' + dest.address + ' finalized.\n' +
            state.venue.hubTails(30));
        state.evidence.at2_transferId = row.transfer_id;

        // The out leg's destination is BTC, so BTC is the chain that must apply it
        // before its balances mean anything; same barrier, other direction.
        const applied = await state.venue.waitForBridgeApplied('BTC', row.transfer_id);
        assert.ok(applied, 'the venue BTC indexer never recorded a bridge_settlements row for ' +
            row.transfer_id + ', so the out leg was never applied.\n' + state.venue.indexerTails(40));
        state.evidence.at2_appliedBlock = String(applied.block_index);

        const after = {
            btcDest: await state.venue.addressBalance('BTC', dest.address, GAS_TICK),
            escrow: escrowOf(await state.venue.bridgeBalances('BTC', GAS_TICK), 'DOGE'),
            dogeSupply: (await state.venue.bridgeBalances('DOGE', GAS_TICK)).supply,
        };
        // THE SOURCE LEG FINALIZED ONCE, asserted before the arithmetic and named rather
        // than inferred from a number. On drive 11 this one burn of 2 finalized as two
        // transfers (`a037a13d…`@1052 and `58b7cc56…`@1053) and the escrow fell by 4, and a
        // red on the escrow alone reads as an arithmetic mystery instead of as the
        // duplicate it is. This is the rail's check on the landed hub fix.
        const dupes = await state.venue.duplicateSourceTransfers();
        const burnLeg = dupes.filter((g) => String(g.srcChain) === String(row.src_chain) &&
            String(g.actionIndex) === String(row.src_action_index));
        state.evidence.at2_duplicateSourceLegs = burnLeg;
        assert.deepStrictEqual(burnLeg, [],
            'the burn at ' + row.src_chain + ':' + row.src_action_index + ' finalized as more ' +
            'than one transfer: ' + JSON.stringify(burnLeg) + '. The escrow arithmetic below ' +
            'cannot hold while one source leg is paid out twice.');

        state.evidence.at2 = { before, after, destAddress: dest.address };

        assert.strictEqual(Number(after.btcDest) - Number(before.btcDest), AT2_BURN,
            dest.address + ' did not gain exactly ' + AT2_BURN + ' on BTC');
        // Section 15's "the escrow address is 3" and "DOGE supply is 3" are the readings
        // on a virgin rail; here the same claim is the baseline plus AT1's lock less
        // this burn, which is the identical arithmetic with the rail's own history in it.
        assert.strictEqual(Number(after.escrow), Number(state.baseline.escrow) + AT1_LOCK - AT2_BURN,
            'the escrow reads ' + after.escrow + ' and not ' +
            (Number(state.baseline.escrow) + AT1_LOCK - AT2_BURN));
        assert.strictEqual(Number(after.dogeSupply), Number(state.baseline.dogeSupply) + AT1_LOCK - AT2_BURN,
            'the DOGE supply reads ' + after.dogeSupply + ' and not ' +
            (Number(state.baseline.dogeSupply) + AT1_LOCK - AT2_BURN));
    });
});
