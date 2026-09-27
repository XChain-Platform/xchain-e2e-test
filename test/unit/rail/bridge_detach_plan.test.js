'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const {
    DETACH_STEPS,
    detachStepNames
} = require('../../helpers/bridge_detach_plan');

describe('bridged list detach plan', function () {
    it('pins the ordered steps and expected copy states', function () {
        assert.deepStrictEqual(DETACH_STEPS, [
            {
                name: 'issue a BTC tick with allow and block lists',
                action: 'issue_btc_tick_with_lists',
                expect: null
            },
            {
                name: 'bridge the tick to DOGE',
                action: 'bridge_btc_tick_to_doge',
                expect: null
            },
            {
                name: 'settle the first policy snapshot',
                action: 'wait_for_initial_snapshot',
                expect: { ALLOW_LIST: 'nonzero', BLOCK_LIST: 'nonzero' }
            },
            {
                name: 'detach the origin block list',
                action: 'detach_origin_block_list',
                expect: null,
                issueFormat: 5,
                sentinel: '0'
            },
            {
                name: 'settle the block-list-zero snapshot',
                action: 'wait_for_detached_snapshot',
                expect: { ALLOW_LIST: 'unchanged', BLOCK_LIST: 0 }
            },
            {
                name: 'send the copy to the formerly blocked address',
                action: 'send_to_formerly_blocked',
                expect: { status: 'valid' }
            }
        ]);
        assert.deepStrictEqual(detachStepNames(), DETACH_STEPS.map(step => step.name));
    });

    it('orders detach before the zero snapshot and the unblocked send', function () {
        const actions = DETACH_STEPS.map(step => step.action);
        const detach = actions.indexOf('detach_origin_block_list');
        const zeroSnapshot = actions.indexOf('wait_for_detached_snapshot');
        const unblockedSend = actions.indexOf('send_to_formerly_blocked');

        assert(detach < zeroSnapshot, 'detach must precede the block-list-zero snapshot');
        assert(zeroSnapshot < unblockedSend,
            'the block-list-zero snapshot must precede the unblocked send');
    });

    it('freezes the list, entries, and non-null expectations', function () {
        assert(Object.isFrozen(DETACH_STEPS));
        assert(DETACH_STEPS.every(Object.isFrozen));
        assert(DETACH_STEPS.filter(step => step.expect !== null)
            .every(step => Object.isFrozen(step.expect)));
    });
});
