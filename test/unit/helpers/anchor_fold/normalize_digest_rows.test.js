'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const {
    normalizeAnchorRowsForDigest
} = require('../../../helpers/anchor_fold/normalize_digest_rows')

describe('normalize anchor rows for digest', function () {
    it('removes volatile columns and preserves every other field', function () {
        const nested = { height: 42 }
        const rows = [{
            id: 7,
            created_at: '2026-09-27T10:00:00.000Z',
            updated_at: '2026-09-27T10:01:00.000Z',
            tx_hash: 'folded',
            chain: 'BTC',
            nested
        }]

        const normalized = normalizeAnchorRowsForDigest(rows)

        assert.deepStrictEqual(normalized, [{
            tx_hash: 'folded',
            chain: 'BTC',
            nested
        }])
        assert.strictEqual(normalized[0].nested, nested)
    })

    it('does not mutate the input array or its row objects', function () {
        const row = { id: 7, created_at: 'created', updated_at: 'updated', chain: 'BTC' }
        const rows = [row]
        const originalRows = rows.map((item) => ({ ...item }))
        const normalized = normalizeAnchorRowsForDigest(rows)

        assert.notStrictEqual(normalized, rows)
        assert.notStrictEqual(normalized[0], row)
        assert.deepStrictEqual(rows, originalRows)
        assert.deepStrictEqual(row, {
            id: 7,
            created_at: 'created',
            updated_at: 'updated',
            chain: 'BTC'
        })
    })

    it('preserves row order', function () {
        const rows = [
            { id: 30, section_index: 3 },
            { id: 10, section_index: 1 },
            { id: 20, section_index: 2 }
        ]

        assert.deepStrictEqual(
            normalizeAnchorRowsForDigest(rows).map((row) => row.section_index),
            [3, 1, 2]
        )
    })
})
