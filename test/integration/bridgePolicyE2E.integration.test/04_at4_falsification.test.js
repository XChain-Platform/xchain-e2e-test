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

// Covers policy AT4. One part of bridgePolicyE2E.integration.test.

const assert = require('assert');
const { SETTLE, BS, BLOCK, BLOCK_TIME, MEMBER_A, copyRow, snapshot, makeFixture } = require('./lib/shared');
const { falsificationCases } = require('./lib/falsification_cases');

const CHAIN_IDENTITY = SETTLE.loadIndexerModule('src/hub/hub_db_sync/chain_identity.js');

// The real mirror apply fence, expecting `ownId`, refuses `row` and admits the same row
// stamped with `ownId`.
function assertFenceRefusesOnlyForeign(row, ownId){
    const fence = Object.assign(Object.create(CHAIN_IDENTITY),
                                { _expectedBtcChainId: ownId, _refusedChainIdRows: new Map() });
    assert.strictEqual(fence.refuseForeignChainRow('policy_snapshots', row), true,
        'a snapshot from a dead chain instance passed the mirror fence');
    assert.strictEqual(fence.refuseForeignChainRow('policy_snapshots',
        Object.assign({}, row, { btc_chain_id: ownId })), false,
        'the mirror fence refused a snapshot of its own chain');
}

// The policy pass outcome for `row`, with `chainId` planted in config as BTC_CHAIN_ID.
async function settleWithPlantedId(validators, row, chainId){
    const { ctx, state } = SETTLE.makeSettleContext({
        coin: 'DOGE', validators: validators, tokens: copyRow(), chainId: chainId,
        blockIndex: BLOCK, blockTime: BLOCK_TIME
    });
    const res = await BS.applyPolicySnapshot(row, ctx);
    return { applied: res.applied, reason: res.reason, terminal: res.terminal,
             injected: state.injected.length };
}

describe('XPOLICY: policy AT4: falsification of a mirrored snapshot', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });

    // Each case asserts that NOTHING was injected and NOTHING was recorded. Asserting
    // the reason string would prove only that the module agrees with itself.

    falsificationCases.forEach((c) => {
        it('applies nothing for ' + c.name, async function(){
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: copyRow(),
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyPolicySnapshot(c.build(ids), ctx);

            assert.strictEqual(res.applied, false, c.name + ' was applied');
            assert.deepStrictEqual(state.injected, [], c.name + ' injected a leg');
            assert.deepStrictEqual(state.settlements, [], c.name + ' recorded a settlement');
            assert.strictEqual(res.terminal, c.terminal,
                c.name + ' was classified ' + (res.terminal ? 'terminal' : 'carried') +
                ', which decides whether the pass ever retries it');
        });
    });

    // Chain identity is the mirror apply fence's (the real refuseForeignChainRow), and the
    // policy pass reads no per-node identity, so a planted BTC_CHAIN_ID changes nothing.
    it('applies nothing for a foreign btc_chain_id', async function(){
        const own = '0'.repeat(64);
        const row = snapshot(ids, { block: [MEMBER_A], btcChainId: 'f'.repeat(64) });
        assertFenceRefusesOnlyForeign(row, own);
        assert.deepStrictEqual(await settleWithPlantedId(validators, row, own),
                               await settleWithPlantedId(validators, row, undefined),
            'the policy pass compared the snapshot against a per-node chain identity');
    });

    it('refuses to inherit onto the ORIGIN chain itself', async function(){
        const row = snapshot(ids, { block: [MEMBER_A] });
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'BTC', validators: validators, tokens: copyRow(),
            blockIndex: BLOCK, blockTime: BLOCK_TIME
        });

        const res = await BS.applyPolicySnapshot(row, ctx);

        assert.strictEqual(res.applied, false, 'the origin chain inherited its own policy');
        assert.strictEqual(res.terminal, true);
        assert.deepStrictEqual(state.injected, []);
    });
});
