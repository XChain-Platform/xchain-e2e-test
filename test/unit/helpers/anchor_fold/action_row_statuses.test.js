'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const {
    statusesForAction
} = require('../../../helpers/anchor_fold/action_row_statuses')

describe('statusesForAction', function () {
    it('selects one action and splits chain rows from its archive head', function () {
        const rows = [
            { action_index: 4, chain: 'BTC', match_batch_seq: null, version: 3, status: 'valid' },
            { action_index: 5, chain: 'DOGE', match_batch_seq: null, version: 3, status: 'other' },
            { action_index: 4, chain: null, match_batch_seq: 9, version: 3, status: 'invalid_archive' },
            { action_index: 4, chain: 'LTC', match_batch_seq: null, version: 3, status: 'valid' },
            { action_index: 4, chain: null, match_batch_seq: 9, version: '2', status: 'chunk' },
            { action_index: 5, chain: null, match_batch_seq: 10, version: 3, status: 'other_archive' }
        ]

        assert.deepStrictEqual(statusesForAction(rows, 4), {
            chainStatuses: ['valid', 'valid'],
            archiveStatuses: ['invalid_archive']
        })
    })

    it('returns no archive statuses when the action has no archive row', function () {
        const rows = [
            { action_index: 7, chain: 'BTC', match_batch_seq: null, version: 3, status: 'valid' },
            { action_index: 7, chain: 'LTC', match_batch_seq: null, version: 3, status: 'valid' }
        ]

        assert.deepStrictEqual(statusesForAction(rows, 7), {
            chainStatuses: ['valid', 'valid'],
            archiveStatuses: []
        })
    })

    it('matches a numeric row action index to a string argument', function () {
        const rows = [
            { action_index: 12, chain: 'BTC', match_batch_seq: null, version: 3, status: 'valid' }
        ]

        assert.deepStrictEqual(statusesForAction(rows, '12'), {
            chainStatuses: ['valid'],
            archiveStatuses: []
        })
    })
})
