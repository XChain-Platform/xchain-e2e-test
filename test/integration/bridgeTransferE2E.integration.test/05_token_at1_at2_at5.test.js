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

// Covers token AT1, AT2 and AT5. One part of bridgeTransferE2E.integration.test.

const assert = require('assert');
const {
    HUB, SETTLE, BS, NETWORK, SNAPSHOT, CP_HEIGHT, BLOCK, BLOCK_TIME, DUE_TIME, DEST_ADDR, SRC_ADDR, makeFixture
} = require('./lib/shared');

describe('XBRIDGE transfer: token AT1, AT2 and AT5: a general token leg', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });

    const TOKEN_AMOUNT = '5.0000';

    function tokenInLeg(identities, overrides){
        const row = HUB.buildTransferRow(Object.assign({
            snapshotBlock: SNAPSHOT, srcChain: 'BTC', srcActionIndex: 9001, srcAddress: SRC_ADDR,
            destChain: 'DOGE', destAddress: DEST_ADDR, tick: 'FUFU', decimals: 4,
            amount: TOKEN_AMOUNT, effectiveTime: DUE_TIME, network: NETWORK
        }, overrides || {}));
        return HUB.signRecord(row, identities);
    }

    it('creates the BTC root and the BTC.FUFU child owned by the bridge role address, then credits the child', async function(){
        const row = tokenInLeg(ids);
        const { ctx, state, config } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators, tokens: {},
            blockIndex: BLOCK, blockTime: BLOCK_TIME,
            proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'FUFU',
                                             balance: '50', height: CP_HEIGHT })
        });

        const res = await BS.applyBridgeTransfer(row, ctx);

        assert.strictEqual(res.applied, true, 'a hub-signed token in leg did not apply: ' + res.reason);
        assert.strictEqual(state.injected.length, 2,
            'expected the <ORIGIN> root and the <ORIGIN>.<NAME> child, saw ' + state.injected.length);
        const ticks = state.injected.map(t => t.data.split('|')[2]);
        assert.deepStrictEqual(ticks, ['BTC', 'BTC.FUFU'],
            'the injected rows are not the root then the child: ' + ticks.join(', '));
        state.injected.forEach(t => assert.strictEqual(t.source, config.ADDRESS.BRIDGE_BTC,
            'a bridged row was not created by the BTC bridge role address on DOGE'));
        // The credit lands on the ROOTED name, never on the origin's native name: a
        // credit to bare FUFU would collide with a DOGE-native FUFU.
        assert.deepStrictEqual(state.credits, [['BTC.FUFU', TOKEN_AMOUNT, DEST_ADDR]]);
        assert.strictEqual(state.actions[0].FORMAT, 5, 'a token settle leg is not XBRIDGE v5');
    });
});

describe('XBRIDGE transfer: token AT1, AT2 and AT5: a general token leg (continued)', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });


    it('AT5: signed decimals that disagree with an existing child row holding supply apply nothing', async function(){
        const row = tokenInLeg(ids);        // signed decimals 4
        const { ctx, state, config } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators,
            tokens: {
                'BTC':      { TICK_ID: 20, DECIMALS: 0, SUPPLY: '0',
                              OWNER: SETTLE.ROLE_ADDRESSES.BRIDGE_BTC },
                'BTC.FUFU': { TICK_ID: 21, DECIMALS: 8, SUPPLY: '5.00000000',
                              OWNER: SETTLE.ROLE_ADDRESSES.BRIDGE_BTC }
            },
            blockIndex: BLOCK, blockTime: BLOCK_TIME,
            proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'FUFU',
                                             balance: '50', height: CP_HEIGHT })
        });
        assert.strictEqual(config.ADDRESS.BRIDGE_BTC, SETTLE.ROLE_ADDRESSES.BRIDGE_BTC);

        const res = await BS.applyBridgeTransfer(row, ctx);

        assert.strictEqual(res.applied, false,
            're-precisioning a bridged row that already holds supply was allowed');
        assert.deepStrictEqual(state.credits, [], 'a decimals-mismatched leg still credited');
        assert.deepStrictEqual(state.settlements, []);
    });
});
