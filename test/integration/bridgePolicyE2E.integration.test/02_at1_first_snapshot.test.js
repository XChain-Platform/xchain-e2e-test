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

// Covers policy AT1. One part of bridgePolicyE2E.integration.test.

const assert = require('assert');
const { SETTLE, BS, BLOCK, BLOCK_TIME, COPY, MEMBER_A, copyRow, snapshot, legs, makeFixture } = require('./lib/shared');

describe('XPOLICY: policy AT1: the first snapshot materializes onto the copy', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });

    it('creates the block list with the exact member, points the copy at it, and records the settlement', async function(){
        const row = snapshot(ids, { block: [MEMBER_A] });
        const { ctx, state, config } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators, tokens: copyRow(),
            blockIndex: BLOCK, blockTime: BLOCK_TIME
        });

        const res = await BS.applyPolicySnapshot(row, ctx);

        assert.strictEqual(res.applied, true, 'a hub-signed snapshot did not apply: ' + res.reason);
        const injected = legs(state);
        assert.strictEqual(injected.length, 2,
            'expected the block-list create and the ISSUE 5 pointer, saw ' + injected.length);

        // Ordinal 2 is BLOCK_CREATE_OR_REMOVE and is consensus-visible: it decides the
        // action index the leg takes on every node.
        assert.strictEqual(injected[0].ordinal, 2, 'the block-list leg is not at its pinned ordinal');
        assert.deepStrictEqual(injected[0].fields, ['LIST', '0', '2', '', MEMBER_A],
            'the injected list is not a type-2 address list holding exactly the signed member');
        assert.strictEqual(injected[0].source, config.ADDRESS.BRIDGE_BTC,
            'the list was not created by the BTC bridge role address on DOGE');
        assert.strictEqual(injected[0].isGenesis, true,
            'the injected leg did not carry IS_GENESIS, so it would hit the bridge-owned LIST refusal');
        assert.ok(injected[0].tx_hash.startsWith('XPOLICY-'),
            'the synthetic transaction is not in the XPOLICY family: ' + injected[0].tx_hash);
        assert.ok(injected[0].tx_hash.endsWith(row.snapshot_id.slice(0, 48)),
            'the synthetic hash is not keyed on this snapshot id');

        // Ordinal 4 is ISSUE_POINT. The ALLOW field is EMPTY (no allow list was created)
        // and the BLOCK field names the action index the list leg took.
        assert.strictEqual(injected[1].ordinal, 4);
        assert.strictEqual(injected[1].fields[0], 'ISSUE');
        assert.strictEqual(injected[1].fields[1], '5');
        assert.strictEqual(injected[1].fields[2], COPY);
        assert.strictEqual(injected[1].fields[3], '', 'ALLOW_LIST was pointed at something');
        assert.strictEqual(injected[1].fields[4], String(state.injected[0] && 5000),
            'the copy was not pointed at the list the create leg minted');

        assert.strictEqual(state.settlements.length, 1);
        assert.strictEqual(state.settlements[0].transfer_id, row.snapshot_id);
        assert.strictEqual(state.settlements[0].kind, 'policy',
            'a policy snapshot was recorded under the transfer kind, which would collide the unique key');
    });
});

describe('XPOLICY: policy AT1: the first snapshot materializes onto the copy (continued)', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });


    it('an ABSENT list injects nothing for it and still records the snapshot', async function(){
        // seq 1 of a tick with no lists that is awake: every leg is a no-op, which is
        // ordinary and must still terminate rather than be re-evaluated forever.
        const row = snapshot(ids, {});
        const { ctx, state } = SETTLE.makeSettleContext({
            coin: 'DOGE', validators: validators, tokens: copyRow(),
            blockIndex: BLOCK, blockTime: BLOCK_TIME
        });

        const res = await BS.applyPolicySnapshot(row, ctx);

        assert.strictEqual(res.applied, true, 'a no-op snapshot did not apply: ' + res.reason);
        assert.deepStrictEqual(state.injected, [], 'an absent list still injected a leg');
        assert.strictEqual(state.settlements.length, 1,
            'a no-op snapshot was not recorded, so it would be re-evaluated on every later block');
        assert.strictEqual(state.actions[0].ACTION, 'XPOLICY',
            'the anchor action is not the internal XPOLICY action');
    });
});
