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

// Covers base AT1. One part of bridgeTransferE2E.integration.test.

const assert = require('assert');
const {
    SETTLE, BS, CP_HEIGHT, BLOCK, BLOCK_TIME, DEST_ADDR, XCHAIN_ROW, inLeg, makeFixture
} = require('./lib/shared');

describe('XBRIDGE transfer: base AT1: the IN leg mints on the destination chain', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });

    it('credits the exact address the record names, at the signed amount, and records the settlement', async function(){
        const row = inLeg(ids);
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW,
            blockIndex: BLOCK, blockTime: BLOCK_TIME,
            proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                             balance: '50', height: CP_HEIGHT })
        });

        const res = await BS.applyBridgeTransfer(row, ctx);

        assert.strictEqual(res.applied, true, 'a hub-signed in leg did not apply: ' + res.reason);
        // Identity, not a count: this tick, this literal amount, this address.
        assert.deepStrictEqual(state.credits, [['XCHAIN', '10.00000000', DEST_ADDR]]);
        assert.deepStrictEqual(state.debits, [], 'an in leg debited something');
        assert.strictEqual(state.settlements.length, 1);
        assert.strictEqual(state.settlements[0].transfer_id, row.transfer_id);
        assert.strictEqual(state.settlements[0].kind, 'transfer');
        assert.strictEqual(state.settlements[0].block_index, BLOCK);
        // FORMAT 2 is the XCHAIN settle leg; 5 is a general token's.
        assert.strictEqual(state.actions[0].FORMAT, 2, 'the injected settle action is not XBRIDGE v2');
    });

    it('creates the XCHAIN row lazily on a chain that holds none', async function(){
        const row = inLeg(ids);
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators, tokens: {},       // no XCHAIN row here
            blockIndex: BLOCK, blockTime: BLOCK_TIME,
            proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                             balance: '50', height: CP_HEIGHT })
        });

        const res = await BS.applyBridgeTransfer(row, ctx);

        assert.strictEqual(res.applied, true, 'the lazy-creation in leg did not apply: ' + res.reason);
        assert.strictEqual(state.injected.length, 1, 'expected exactly one injected token row');
        const tx = state.injected[0];
        assert.strictEqual(tx.isGenesis, true,
            'the injected row did not carry IS_GENESIS, so it would hit the off-BTC ISSUE refusal');
        const fields = tx.data.split('|');
        assert.strictEqual(fields[0], 'ISSUE');
        assert.strictEqual(fields[2], 'XCHAIN', 'the lazily created row is not the GAS tick');
        assert.deepStrictEqual(state.credits, [['XCHAIN', '10.00000000', DEST_ADDR]]);
    });

    it('refuses a FORGED escrow proof and moves nothing (D2)', async function(){
        const row = inLeg(ids);
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW,
            blockIndex: BLOCK, blockTime: BLOCK_TIME,
            // A well-formed envelope whose checkpoint commits a state root the escrow
            // leaf is not under: the forgery a mint must never be built on.
            proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                             balance: '50', height: CP_HEIGHT, forgeRoot: true })
        });

        const res = await BS.applyBridgeTransfer(row, ctx);

        assert.strictEqual(res.applied, false, 'a forged escrow proof minted units');
        assert.deepStrictEqual(state.credits, [], 'a forged proof still credited');
        assert.deepStrictEqual(state.settlements, [], 'a forged proof still recorded a settlement');
    });

    it('refuses an in leg with no proof at all, rather than defaulting open', async function(){
        const row = inLeg(ids);
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW,
            blockIndex: BLOCK, blockTime: BLOCK_TIME
        });

        const res = await BS.applyBridgeTransfer(row, ctx);

        assert.strictEqual(res.applied, false, 'an in leg minted with no escrow proof');
        assert.deepStrictEqual(state.credits, []);
    });
});
