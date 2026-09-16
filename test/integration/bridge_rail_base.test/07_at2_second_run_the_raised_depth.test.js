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
    GAS_TICK,
    state,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

// ── AT2, second run ────────────────────────────────────────────────────────────
// LAST, and deliberately so. It re-pins the federation's DOGE depth at 60 and then waits
// out sixty DOGE blocks, and the burn it leaves behind sits in flight for the BTC relay
// margin afterwards; running it earlier would leave an unapplied out leg inside AT6's and
// AT7's invariant readings. Its own claim is a MEASUREMENT and depends on nothing later.
bridgeRailSuite('AT2, second run: the raised depth', function () {

    it('waits the raised depth when XCHAIN_CONFIRMATIONS_DOGE is 60, and measures it', async function () {
        this.timeout(0);
        if (needsFederation(this, 'AT2 raised depth')) return;
        assert.ok(state.at1Dest, 'AT2 burns from the address AT1 named, so AT1 must have run');

        // The measurement is the POINT of this case: a depth the engine silently ignored
        // would finalize in seconds and the case would pass for the wrong reason, so the
        // elapsed DOGE height at finalization is asserted, not the wall clock.
        await state.venue.rewireHubs({ DOGE: 60 });
        const dest = await state.venue.funded('AT2B.DEST',
            () => cryptoHelper.getNewFundedAddress('AT2B.DEST', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));

        const heightAt = async () => Number((await chainRail.withRail(state.dogeRail,
            () => indexerConnector.call('getblockhashes', {}))).block_index);
        const startHeight = await heightAt();

        const burnTx = await chainRail.withRail(state.dogeRail, () =>
            transactionHelper.createAndSendTransaction(
                state.at1Dest, burnWireV1(dest.address, 1, '')));
        const row = await state.venue.waitForFinalizedTransfer(
            (r) => String(r.dest_address) === dest.address, { timeoutMs: 60 * 60 * 1000 });
        const endHeight = await heightAt();
        state.evidence.at2b = { burnTx, startHeight, endHeight, depth: endHeight - startHeight,
            finalized: !!row, transferId: row ? row.transfer_id : null };
        assert.ok(row, 'the 60-confirmation burn never finalized within the budget (DOGE moved from ' +
            startHeight + ' to ' + endHeight + ')');
        assert.ok(endHeight - startHeight >= 60,
            'the transfer finalized after only ' + (endHeight - startHeight) + ' DOGE block(s), ' +
            'so XCHAIN_CONFIRMATIONS_DOGE=60 was not honoured');
        await state.venue.rewireHubs({ DOGE: 1 });
    });
});
