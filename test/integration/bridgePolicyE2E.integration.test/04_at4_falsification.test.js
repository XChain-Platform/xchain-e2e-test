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

    it('applies nothing for a foreign btc_chain_id', async function(){
        const row = snapshot(ids, { block: [MEMBER_A], btcChainId: 'f'.repeat(64) });
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators, tokens: copyRow(),
            chainId: '0'.repeat(64),
            blockIndex: BLOCK, blockTime: BLOCK_TIME
        });

        const res = await BS.applyPolicySnapshot(row, ctx);

        assert.strictEqual(res.applied, false, 'a snapshot from a dead chain instance applied');
        assert.strictEqual(res.terminal, true);
        assert.deepStrictEqual(state.injected, []);
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
