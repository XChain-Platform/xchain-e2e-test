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

// Covers policy AT2 and AT6. One part of bridgePolicyE2E.integration.test.

const assert = require('assert');
const { SETTLE, BS, BLOCK, BLOCK_TIME, COPY, MEMBER_A, MEMBER_B, MEMBER_C, copyRow, snapshot, legs, makeFixture } = require('./lib/shared');

describe('XPOLICY: policy AT2: an issuer edit reaches the copy', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });

    it('injects one REMOVE and one ADD against the existing list, and does not move the pointer', async function(){
        const row = snapshot(ids, { policySeq: 2, block: [MEMBER_B, MEMBER_C] });
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators,
            tokens: copyRow({ BLOCK_LIST: 77 }),
            lists: { 77: [MEMBER_A, MEMBER_B] },     // A is dropped, C is added
            mirrorPolicies: [],
            blockIndex: BLOCK, blockTime: BLOCK_TIME
        });

        const res = await BS.applyPolicySnapshot(row, ctx);

        assert.strictEqual(res.applied, true, 'the edit snapshot did not apply: ' + res.reason);
        const injected = legs(state);
        assert.strictEqual(injected.length, 2,
            'a change with both a removal and an addition is two actions, saw ' + injected.length);
        // A LIST format 1 carries ONE edit verb for the whole action, which is exactly
        // why the removal and the addition have separate pinned ordinals.
        assert.strictEqual(injected[0].ordinal, 2);
        assert.deepStrictEqual(injected[0].fields, ['LIST', '1', '2', '77', '', MEMBER_A],
            'the removal leg does not name exactly the dropped member');
        assert.strictEqual(injected[1].ordinal, 3);
        assert.deepStrictEqual(injected[1].fields, ['LIST', '1', '1', '77', '', MEMBER_C],
            'the addition leg does not name exactly the added member');
        assert.ok(!injected.some(l => l.fields[0] === 'ISSUE'),
            'an edit moved the copy pointer, which would orphan the list');
    });
});

describe('policy AT6: sleep travels, and only when it changes', function(){

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });

    it('injects an indefinite SLEEP at its pinned ordinal when the origin is asleep', async function(){
        const row = snapshot(ids, { sleeping: true });
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators, tokens: copyRow(),
            blockIndex: BLOCK, blockTime: BLOCK_TIME
        });

        const res = await BS.applyPolicySnapshot(row, ctx);

        assert.strictEqual(res.applied, true, 'the sleeping snapshot did not apply: ' + res.reason);
        const injected = legs(state);
        assert.strictEqual(injected.length, 1, 'expected exactly the SLEEP leg');
        assert.strictEqual(injected[0].ordinal, 5);
        // resume_block -1, never the origin's own resume height: block heights are not
        // comparable across chains.
        assert.deepStrictEqual(injected[0].fields, ['SLEEP', '1', '-1', COPY]);
    });
});
