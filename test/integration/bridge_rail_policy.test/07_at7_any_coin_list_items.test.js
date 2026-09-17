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
 * Policy AT7 (any-coin items and replay): below the flag a LIST on DOGE regtest carrying a BTC
 * bech32 item records it in list_items_invalid; above the flag it admits it; the replay corpus
 * for every chain is hash-identical below the activation with the widened code present.
 *
 * A BECH32 ITEM because it is the one shape that tells the rules apart on regtest: BTC, LTC and
 * DOGE share the legacy p2pkh and p2sh prefixes there (spec section 8), so a legacy address is
 * valid for every coin and would pass under either rule.
 *
 ********************************************************************/

'use strict';

const { listCreateWire } = require('../../helpers/bridgeRailVenue');
const {
    assert,
    cryptoHelper,
    state,
    dogeAction,
    fundDoge,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'policy AT7: any-coin list items';

bridgeRailSuite(GROUP, function () {
    it('policy AT7 (above the flag): a LIST on DOGE carrying a BTC bech32 item admits it into list_items', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT7 admission')) return;
        const btcAddress = await cryptoHelper.getNewAddress('POLICY.AT7.BECH32', 'bitcoin', NETWORK, null, 'segwit', 0);
        const bech32 = String(btcAddress.address);
        assert.ok(/^bcrt1/.test(bech32), 'the BTC fixture address is not bech32: ' + bech32);
        const owner = await fundDoge('POLICY.AT7.OWNER', 2);
        const list = await dogeAction(owner, listCreateWire(2, [bech32], 'policy AT7'), 'lists');
        const admitted = await state.venue.queryIndexerDb('DOGE',
            'SELECT ia.address AS address FROM list_items li INNER JOIN index_addresses ia ON (ia.id = li.item_id) WHERE li.action_index = ?',
            [list.actionIndex]);
        const refused = await state.venue.queryIndexerDb('DOGE',
            'SELECT COUNT(*) AS n FROM list_items_invalid WHERE action_index = ?', [list.actionIndex]);
        state.evidence.at7 = { bech32, list, admitted: admitted.map((r) => r.address), invalidCount: Number(refused[0].n) };
        assert.strictEqual(list.status, 'valid', 'the DOGE LIST graded ' + list.status);
        assert.deepStrictEqual(admitted.map((r) => r.address), [bech32], 'list_items holds ' + JSON.stringify(admitted));
        assert.strictEqual(Number(refused[0].n), 0, 'list_items_invalid recorded the BTC bech32 item above the flag');
    });

    // Spec AT7: "below the flag a LIST on DOGE regtest carrying a BTC bech32 item records it in
    // list_items_invalid". No DOGE regtest block is below TOKEN_POLICY_INHERITANCE_ACTIVATION.
    it.skip('policy AT7 (below the flag): the BTC bech32 item is recorded in list_items_invalid. NOT DRIVABLE on regtest: ' +
        '"below the flag", and TOKEN_POLICY_INHERITANCE_ACTIVATION is 0 here');

    // Spec AT7: "the replay corpus for every chain is hash-identical below the activation with the
    // widened code present (hard gate)". A replay corpus run, not a rail drive: policy frontier
    // row 11 owns it.
    it.skip('policy AT7 (replay): the replay corpus for every chain is hash-identical below the activation. NOT A RAIL DRIVE: ' +
        '"the replay corpus for every chain", policy frontier row 11');
});
