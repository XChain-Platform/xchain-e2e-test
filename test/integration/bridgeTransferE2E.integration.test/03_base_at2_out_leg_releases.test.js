/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

// Covers base AT2. One part of bridgeTransferE2E.integration.test.

const assert = require('assert');
const {
    SETTLE, BS, BLOCK, BLOCK_TIME, BTC_ADDR, XCHAIN_ROW, outLeg, makeFixture
} = require('./lib/shared');

describe('XBRIDGE transfer: base AT2: the OUT leg releases escrow on the origin chain', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });

    it('debits the escrow role address and credits the address the burn named', async function(){
        const row = outLeg(ids);
        const { ctx, state, config } = SETTLE.makeSettleContext({
            coin: 'BTC', validators: validators, tokens: XCHAIN_ROW,
            balances: { 7: '5.00000000' },          // the escrow holds 5, the burn asks 2
            blockIndex: BLOCK, blockTime: BLOCK_TIME
        });

        const res = await BS.applyBridgeTransfer(row, ctx);

        assert.strictEqual(res.applied, true, 'a hub-signed out leg did not apply: ' + res.reason);
        assert.deepStrictEqual(state.debits,
            [['XCHAIN', '2.00000000', config.ADDRESS.BRIDGE_DOGE]],
            'the release did not debit the DOGE escrow role address on BTC');
        assert.deepStrictEqual(state.credits, [['XCHAIN', '2.00000000', BTC_ADDR]]);
        assert.strictEqual(state.settlements[0].transfer_id, row.transfer_id);
    });

    it('an escrow short of the amount moves nothing (AT4)', async function(){
        const row = outLeg(ids);
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'BTC', validators: validators, tokens: XCHAIN_ROW,
            balances: { 7: '1.00000000' },          // one unit short of the 2 released
            blockIndex: BLOCK, blockTime: BLOCK_TIME
        });

        const res = await BS.applyBridgeTransfer(row, ctx);

        assert.strictEqual(res.applied, false, 'an out leg drained the escrow past zero');
        assert.deepStrictEqual(state.debits, []);
        assert.deepStrictEqual(state.credits, []);
        assert.deepStrictEqual(state.settlements, [],
            'a refused out leg still recorded a settlement, which would make it unretryable');
    });
});
