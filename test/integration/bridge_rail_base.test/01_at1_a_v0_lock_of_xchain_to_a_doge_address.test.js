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
    escrowOf,
    GAS_TICK,
    AT1_LOCK,
    state,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

async function prepareAt1Lock() {
    // FUNDED WITH 5 COIN, NOT 1: this address is the source of four later DOGE legs
    // (AT2's burn, AT5's counter-order, AT6's DESTROY, AT2's second burn) and each
    // one spends a native-coin fee out of the same balance. The funding call sends
    // ONE output whatever the amount, so it buys no extra candidate inputs; what
    // keeps the legs apart is the ORDER they run in. The encoder reserves an
    // address's inputs for five minutes once it has built from them, so every leg
    // here is separated by a barrier that waits minutes on a settlement. Drive 7
    // ran them back to back and got "all 1 candidate input(s) are reserved by a
    // transaction built in the last 5 minutes" twice.
    const dest = await state.venue.funded('AT1.DEST', () => chainRail.withRail(state.dogeRail,
        () => cryptoHelper.getNewFundedAddress('AT1.DEST', 'dogecoin', NETWORK, null, 'legacy', 0, 5, false)));
    // KEPT AS THE RECORD, not re-fetched later by label; see the declaration.
    state.at1Dest = dest;
    const sender = await state.venue.funded('AT1.SENDER',
        () => cryptoHelper.getNewFundedAddress('AT1.SENDER', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));
    await mintHelper.sendMintV0(sender, GAS_TICK, AT1_LOCK, sender.address, '');

    const before = {
        senderBtc: await state.venue.addressBalance('BTC', sender.address, GAS_TICK),
        escrow: escrowOf(await state.venue.bridgeBalances('BTC', GAS_TICK), 'DOGE'),
        destDoge: await state.venue.addressBalance('DOGE', dest.address, GAS_TICK),
    };

    const lockTx = await transactionHelper.createAndSendTransaction(
        sender, lockWireV0('DOGE', dest.address, AT1_LOCK, ''));
    state.evidence.at1_lockTx = lockTx;

    const row = await state.venue.waitForFinalizedTransfer(
        (r) => String(r.src_chain) === 'BTC' && String(r.dest_chain) === 'DOGE' &&
               String(r.dest_address) === dest.address && String(r.tick) === GAS_TICK);
    return { dest, sender, before, row };
}

function readGasParams(doge) {
    // AT1 as first framed compared the DOGE row against the STANDING BTC
    // regtest row byte for byte. That row predates the bridge's shared parameter
    // set (genesis.js gasTokenParams, xchain-bridge.md section 9 and D66): measured
    // on this rail it carries decimals 0, max_mint 100000, description
    // "XChain GAS Token" and mint_start_block 0, a fixture written by a code path
    // from before the shared helper existed
    // (measured by the token-row lane on that date). Asserting
    // DOGE-equals-BTC on that fixture fails no matter what the bridge does, so this
    // case instead asserts the DOGE row against the ONE parameter set the spec
    // requires every XCHAIN row to carry, field by field, and leaves the BTC row
    // uncompared.
    // FROM THE PINNED ROOT when a drive has one. AT1 grades the row the PINNED indexer
    // created, so reading the expected parameter set out of the SHARED checkout would
    // compare one build's output against another build's expectations. Unset keeps the
    // relative path, so a drive that pins nothing behaves exactly as before.
    const genesisPath  = process.env.BRIDGE_RAIL_REPO_ROOT
        ? require('path').join(process.env.BRIDGE_RAIL_REPO_ROOT, 'xchain-indexer', 'src', 'chain', 'genesis.js')
        : '../../../../xchain-indexer/src/chain/genesis.js';
    const Genesis      = require(genesisPath);
    // THE FILE THIS CASE'S EXPECTATIONS CAME FROM, resolved rather than described,
    // because drive 13 read them out of the shared checkout while the row under test
    // was created by the pinned one.
    state.evidence.at1_genesisModule = require.resolve(genesisPath);
    const genesisUtil  = { isNull: (v) => (v === null || v === undefined || v === '') };
    // A bare Genesis instance built only to read gasTokenParams(): the DB/actions
    // arguments are never exercised by that method, only this.config and this.util.
    const gasParams = new Genesis(
        { processTransaction: async () => {} },
        { getTickerId: async () => null, getTokenInfo: async () => false },
        { COIN: 'DOGE', NETWORK: NETWORK, GAS: GAS_TICK, ADDRESS: { GAS: null } },
        genesisUtil
    ).gasTokenParams(null);
    state.evidence.at1_tokenParams = { doge: doge.params, dogeOwner: doge.ownerAddress,
        gasTokenParams: gasParams };
    return gasParams;
}

// ── AT1 ────────────────────────────────────────────────────────────────────────
bridgeRailSuite('AT1: a v0 lock of ' + AT1_LOCK + ' XCHAIN to a DOGE address', function () {

    it('finalizes at the pinned depth and credits the exact DOGE address, the escrow and the supply', async function () {
        this.timeout(0);
        if (needsFederation(this, 'AT1')) return;

        assert.ok(state.baseline, 'AT1 asserts deltas from the drained baseline, so the baseline case ' +
            'must have run');
        const { dest, sender, before, row } = await prepareAt1Lock();
        assert.ok(row, 'no bridge_transfers row naming ' + dest.address + ' was finalized by the venue ' +
            'federation within the budget.\n' + state.venue.hubTails(30));
        state.evidence.at1_transferId = row.transfer_id;
        state.evidence.at1_snapshotBlock = String(row.snapshot_block);

        // THE FEDERATION AGREEING IS NOT THE DESTINATION APPLYING. Hold for the DOGE
        // indexer's own settlement record before reading any DOGE state; see
        // `waitForBridgeApplied` for the false red this barrier exists to stop.
        const applied = await state.venue.waitForBridgeApplied('DOGE', row.transfer_id);
        assert.ok(applied, 'the venue DOGE indexer never recorded a bridge_settlements row for ' +
            row.transfer_id + ', so the in leg was never applied.\n' + state.venue.indexerTails(40));
        state.evidence.at1_appliedBlock = String(applied.block_index);

        // BY IDENTITY: the credit is asserted on the address the lock NAMED, not on
        // "some address gained 5".
        const after = {
            senderBtc: await state.venue.addressBalance('BTC', sender.address, GAS_TICK),
            escrow: escrowOf(await state.venue.bridgeBalances('BTC', GAS_TICK), 'DOGE'),
            destDoge: await state.venue.addressBalance('DOGE', dest.address, GAS_TICK),
            dogeSupply: (await state.venue.bridgeBalances('DOGE', GAS_TICK)).supply,
        };
        state.evidence.at1 = { before, after, destAddress: dest.address, senderAddress: sender.address };

        assert.strictEqual(Number(after.destDoge) - Number(before.destDoge), AT1_LOCK,
            'the DOGE balance of ' + dest.address + ' did not gain exactly ' + AT1_LOCK);
        assert.strictEqual(Number(after.escrow) - Number(before.escrow || 0), AT1_LOCK,
            'ADDRESS.BRIDGE_DOGE on BTC did not gain exactly ' + AT1_LOCK);
        assert.strictEqual(Number(before.senderBtc) - Number(after.senderBtc), AT1_LOCK,
            'the sender ' + sender.address + ' was not debited exactly ' + AT1_LOCK +
            ' XCHAIN (the native fee is a coin output and never a tick debit)');
        // Section 15 writes this as "the DOGE XCHAIN supply is 5", which is the reading
        // on a rail whose escrow starts empty. This rail's escrow carries
        // `baseline.dogeSupply` units that cannot be returned (header note 3), so the
        // same claim is driven as an exact rise of AT1_LOCK over the drained baseline.
        assert.strictEqual(Number(after.dogeSupply) - Number(state.baseline.dogeSupply), AT1_LOCK,
            'the DOGE XCHAIN supply moved from ' + state.baseline.dogeSupply + ' to ' +
            after.dogeSupply + ', which is not a rise of exactly ' + AT1_LOCK);
    });
});

bridgeRailSuite('AT1: a v0 lock of ' + AT1_LOCK + ' XCHAIN to a DOGE address', function () {
    it('creates the DOGE token row with the shared gas-token parameter set, and the bridge role owner', async function () {
        this.timeout(0);
        if (needsFederation(this, 'AT1 token row')) return;
        const doge = await state.venue.tokenParameters('DOGE', GAS_TICK);
        assert.ok(doge, 'the in leg created no XCHAIN row on DOGE');

        const gasParams = readGasParams(doge);

        assert.strictEqual(gasParams.tick, GAS_TICK,
            'gasTokenParams() itself does not carry the gas tick, so the parameter source is wrong');
        assert.strictEqual(Number(doge.params.decimals), Number(gasParams.decimals),
            'the DOGE row\'s decimals (' + doge.params.decimals + ') do not match gasTokenParams() (' +
            gasParams.decimals + ')');
        assert.strictEqual(Number(doge.params.max_supply), Number(gasParams.maxSupply),
            'the DOGE row\'s max_supply (' + doge.params.max_supply + ') does not match gasTokenParams() (' +
            gasParams.maxSupply + ')');
        // MAX_MINT is never in gasTokenParams(): the wire carries it empty, which the
        // uncapped sentinel this row must land on, is 0.
        assert.strictEqual(Number(doge.params.max_mint || 0), 0,
            'the DOGE row\'s max_mint (' + doge.params.max_mint + ') is not the uncapped sentinel ' +
            'an empty MAX_MINT field on the wire produces');
        assert.strictEqual(doge.params.description, gasParams.description,
            'the DOGE row\'s description (' + doge.params.description + ') does not match ' +
            'gasTokenParams() (' + gasParams.description + ')');
        assert.strictEqual(Number(doge.params.mint_start_block), Number(gasParams.mintStartBlock),
            'the DOGE row\'s mint_start_block (' + doge.params.mint_start_block + ') does not match ' +
            'gasTokenParams() (' + gasParams.mintStartBlock + ')');

        // The owner is a different string on each chain BY CONSTRUCTION, so it is compared
        // by ROLE. Asserting the strings equal would be asserting something false.
        const dogeGas = await state.venue.roleAddress('DOGE', 'GAS');
        assert.strictEqual(doge.ownerAddress, dogeGas);
    });
});
