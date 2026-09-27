'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

function frozenStep(name, action, expect, details = {}) {
    const frozenExpect = expect === null ? null : Object.freeze({ ...expect });
    return Object.freeze({ name, action, expect: frozenExpect, ...details });
}

const DETACH_STEPS = Object.freeze([
    frozenStep('issue a BTC tick with allow and block lists', 'issue_btc_tick_with_lists', null),
    frozenStep('bridge the tick to DOGE', 'bridge_btc_tick_to_doge', null),
    frozenStep('settle the first policy snapshot', 'wait_for_initial_snapshot', {
        ALLOW_LIST: 'nonzero',
        BLOCK_LIST: 'nonzero'
    }),
    frozenStep('detach the origin block list', 'detach_origin_block_list', null, {
        issueFormat: 5,
        sentinel: '0'
    }),
    frozenStep('settle the block-list-zero snapshot', 'wait_for_detached_snapshot', {
        ALLOW_LIST: 'unchanged',
        BLOCK_LIST: 0
    }),
    frozenStep('send the copy to the formerly blocked address', 'send_to_formerly_blocked', {
        status: 'valid'
    })
]);

module.exports = { DETACH_STEPS };
