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
    state,
    hubListRows,
    gateReadings,
    needsFederation,
    bridgeRailSuite,
} = require('./bridge_rail_list_share.test/support');

bridgeRailSuite('list_share T0: the three-chain venue is armed and empty', function () {
    it('list_share T0: no version exists, every list gate is armed, and DOGE confirmations are one', async function () {
        this.timeout(0);
        if (needsFederation(this, 'list_share T0')) return;
        const rows = await hubListRows(null);
        assert.deepStrictEqual(rows, [], 'the new venue already holds a shared-list version');
        const gates = await gateReadings();
        const unarmed = gates.filter((reading) => !reading.armed);
        assert.deepStrictEqual(unarmed, [], 'unarmed venue gates: ' + JSON.stringify(unarmed));
        const overlay = await state.venue.rewireHubs({ BTC: 1, DOGE: 1, LTC: 1 });
        assert.strictEqual(overlay.XCHAIN_CONFIRMATIONS_DOGE, '1',
            'the venue hubs read DOGE confirmations ' + overlay.XCHAIN_CONFIRMATIONS_DOGE);
        state.evidence.t0 = { gates, confirmations: {
            BTC: overlay.XCHAIN_CONFIRMATIONS_BTC,
            DOGE: overlay.XCHAIN_CONFIRMATIONS_DOGE,
            LTC: overlay.XCHAIN_CONFIRMATIONS_LTC,
        } };
    });
});
