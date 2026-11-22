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

// Covers base AT4. One part of bridgeTransferE2E.integration.test.

const assert = require('assert');
const {
    SETTLE, BS, CP_HEIGHT, BLOCK, BLOCK_TIME, XCHAIN_ROW, inLeg, makeFixture
} = require('./lib/shared');
const { falsificationCases } = require('./lib/falsification_cases');

const CHAIN_IDENTITY = SETTLE.loadIndexerModule('src/hub/hub_db_sync/chain_identity.js');

describe('XBRIDGE transfer: base AT4: falsification of a mirrored record', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });

    // Each case moves ONE property of a record that is otherwise exactly the record the
    // happy path applied, and asserts the LEDGER, not the reason string: a reason the
    // module also defines would prove nothing about the guard.
    falsificationCases.forEach((c) => {
        it('applies nothing for ' + c.name, async function(){
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW,
                blockIndex: BLOCK, blockTime: BLOCK_TIME,
                proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                                 balance: '50', height: CP_HEIGHT })
            });

            const res = await BS.applyBridgeTransfer(c.build(ids), ctx);

            assert.strictEqual(res.applied, false, c.name + ' was applied');
            assert.deepStrictEqual(state.credits, [], c.name + ' credited');
            assert.deepStrictEqual(state.debits, [], c.name + ' debited');
            assert.deepStrictEqual(state.settlements, [], c.name + ' recorded a settlement');
        });
    });

    // Chain identity is the mirror apply fence's: the real refuseForeignChainRow drops a dead
    // chain's record before any settle pass reads it, and the pass reads no per-node identity,
    // so a BTC_CHAIN_ID planted in its config must leave the outcome unchanged.
    it('applies nothing for a foreign btc_chain_id', async function(){
        const own = '0'.repeat(64);
        const row = inLeg(ids, { btcChainId: 'f'.repeat(64) });
        const fence = Object.assign(Object.create(CHAIN_IDENTITY),
                                    { _expectedBtcChainId: own, _refusedChainIdRows: new Map() });
        assert.strictEqual(fence.refuseForeignChainRow('bridge_transfers', row), true,
            'a record minted on a dead chain instance passed the mirror fence');
        assert.strictEqual(fence.refuseForeignChainRow('bridge_transfers', inLeg(ids, { btcChainId: own })),
            false, 'the mirror fence refused a record of its own chain');

        const settle = async (chainId) => {
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW, chainId: chainId,
                blockIndex: BLOCK, blockTime: BLOCK_TIME,
                proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                                 balance: '50', height: CP_HEIGHT })
            });
            const res = await BS.applyBridgeTransfer(row, ctx);
            return { applied: res.applied, reason: res.reason, credits: state.credits.length };
        };
        assert.deepStrictEqual(await settle(own), await settle(undefined),
            'the settle pass compared the record against a per-node chain identity');
    });
});

describe('XBRIDGE transfer: base AT4: falsification of a mirrored record (continued)', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });


    it('does not apply a record twice (the local settlement record, not the mirror)', async function(){
        const row = inLeg(ids);
        const seeded = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW,
            settled: [row.transfer_id + '|transfer'],
            blockIndex: BLOCK, blockTime: BLOCK_TIME,
            proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                             balance: '50', height: CP_HEIGHT })
        });

        const res = await BS.applyBridgeTransfer(row, seeded.ctx);

        assert.strictEqual(res.applied, false, 'an already-settled transfer minted a second time');
        assert.deepStrictEqual(seeded.state.credits, []);
    });
});
