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

// Covers policy AT5. One part of bridgePolicyE2E.integration.test.

const assert = require('assert');
const { SETTLE, BS, BLOCK, BLOCK_TIME, MEMBER_A, MEMBER_B, copyRow, snapshot, legs, makeFixture } = require('./lib/shared');

describe('XPOLICY: policy AT5: apply order is by policy_seq, never by time', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });

    it('carries a later seq forward while an earlier finalized seq is unapplied', async function(){
        const seq1 = snapshot(ids, { policySeq: 1, block: [MEMBER_A] });
        const seq2 = snapshot(ids, { policySeq: 2, block: [MEMBER_B] });
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators, tokens: copyRow(),
            // The mirror holds seq 1 finalized; nothing has applied it here yet.
            mirrorPolicies: [ { snapshot_id: seq1.snapshot_id, policy_seq: 1 } ],
            blockIndex: BLOCK, blockTime: BLOCK_TIME
        });

        const res = await BS.applyPolicySnapshot(seq2, ctx);

        assert.strictEqual(res.applied, false,
            'seq 2 applied over an unapplied seq 1, which leaves the copy on stale membership forever');
        assert.strictEqual(res.terminal, false,
            'a missing earlier seq was classified terminal, so the copy could never catch up');
        assert.deepStrictEqual(state.injected, []);
        assert.deepStrictEqual(state.settlements, []);
    });

    it('applies a later seq when the earlier one is already recorded here', async function(){
        const seq1 = snapshot(ids, { policySeq: 1, block: [MEMBER_A] });
        const seq2 = snapshot(ids, { policySeq: 2, block: [MEMBER_B] });
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators,
            tokens: copyRow({ BLOCK_LIST: 77 }),
            lists: { 77: [MEMBER_A] },
            mirrorPolicies: [ { snapshot_id: seq1.snapshot_id, policy_seq: 1 } ],
            settled: [ seq1.snapshot_id + '|policy' ],
            blockIndex: BLOCK, blockTime: BLOCK_TIME
        });

        const res = await BS.applyPolicySnapshot(seq2, ctx);

        assert.strictEqual(res.applied, true, 'seq 2 did not apply behind a recorded seq 1: ' + res.reason);
        const fields = legs(state).map(l => l.fields);
        assert.deepStrictEqual(fields, [
            ['LIST', '1', '2', '77', '', MEMBER_A],
            ['LIST', '1', '1', '77', '', MEMBER_B]
        ], 'seq 2 did not bring the existing list to its new membership');
    });

    it('a snapshot ahead of the block protocol time is carried, not refused', async function(){
        const row = snapshot(ids, { block: [MEMBER_A], effectiveTime: BLOCK_TIME + 600 });
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators, tokens: copyRow(),
            blockIndex: BLOCK, blockTime: BLOCK_TIME
        });

        const res = await BS.applyPolicySnapshot(row, ctx);

        assert.strictEqual(res.applied, false);
        assert.strictEqual(res.terminal, false, 'a not-yet-due snapshot was made terminal');
        assert.deepStrictEqual(state.injected, []);
    });

    it('a chain holding no copy of the tick carries the snapshot forward', async function(){
        const row = snapshot(ids, { block: [MEMBER_A] });
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators, tokens: {},     // no BTC.FUFU here yet
            blockIndex: BLOCK, blockTime: BLOCK_TIME
        });

        const res = await BS.applyPolicySnapshot(row, ctx);

        assert.strictEqual(res.applied, false);
        assert.strictEqual(res.terminal, false,
            'a chain with no copy yet was made terminal, so a later transfer could never gain the policy');
        assert.deepStrictEqual(state.injected, []);
    });
});
