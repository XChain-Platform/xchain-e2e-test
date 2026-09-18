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
 * Token AT2: a v4 burn of 2 of the AT1 units to a BTC address; escrow 3, supply 3, the
 * BTC address +2. The out leg to BTC waits out the BTC relay margin, which is why the
 * apply budget is the venue's BTC default (the better part of an hour).
 *
 ********************************************************************/

'use strict';

const {
    assert,
    burnWireV4,
    LOCK,
    BURN,
    state,
    dogeAction,
    fundBtc,
    tokenSnapshot,
    settleLeg,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

bridgeRailSuite('token AT2: a v4 burn of ' + BURN + ' back to a BTC address', function () {
    it('token AT2: releases exactly ' + BURN + ' from the escrow to the BTC address; escrow ' + (LOCK - BURN) + ', supply ' + (LOCK - BURN), async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT2')) return;
        const T = state.tokens;
        assert.ok(state.evidence.at1_dogeChild, 'AT1 must have run');
        T.btcReceiver = await fundBtc('TOKEN.AT2.RECEIVER');
        const before = await tokenSnapshot('at2_before', T.tick, T.dest);
        before.receiver = await state.venue.addressBalance('BTC', T.btcReceiver.address, T.tick);

        const burn = await dogeAction(T.dest, burnWireV4(T.bridged, T.btcReceiver.address, BURN, 'token AT2'), 'xbridges');
        state.evidence.at2_burn = burn;
        assert.strictEqual(burn.status, 'valid', 'XBRIDGE v4 burn graded ' + burn.status);
        // The burn debits the copy at its own block: supply and the holder move before the
        // federation has signed anything.
        const burned = await tokenSnapshot('at2_after_burn', T.tick, T.dest);
        assert.strictEqual(burned.supply, LOCK - BURN, 'DOGE supply after the burn reads ' + burned.supply);
        assert.strictEqual(Number(burned.destBridged), LOCK - BURN, T.dest.address + ' holds ' + burned.destBridged + ' after the burn');

        const leg = await settleLeg('the AT2 burn',
            (r) => String(r.src_chain) === 'DOGE' && String(r.dest_chain) === 'BTC' &&
                   String(r.dest_address) === T.btcReceiver.address && String(r.tick) === T.tick, 'BTC');
        state.evidence.at2_transfer = leg.transfer;
        const after = await tokenSnapshot('at2_after', T.tick, T.dest);
        after.receiver = await state.venue.addressBalance('BTC', T.btcReceiver.address, T.tick);
        state.evidence.at2 = { before, after };
        assert.strictEqual(Number(after.receiver) - Number(before.receiver), BURN,
            'the BTC receiver gained ' + (Number(after.receiver) - Number(before.receiver)));
        assert.strictEqual(after.escrow, LOCK - BURN, 'escrow reads ' + after.escrow);
        assert.strictEqual(after.supply, LOCK - BURN, 'DOGE supply reads ' + after.supply);
        assert.strictEqual(Number(after.destBridged), LOCK - BURN, T.dest.address + ' holds ' + after.destBridged);
    });
});
