// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const assert = require('assert')
const { expectedFoldRows } = require('../../../helpers/anchor_fold/expected_fold_rows')

const sections = [
    { chain: 'LTC', checkpoint_seq: 31 },
    { chain: 'BTC', checkpoint_seq: 47 },
    { chain: 'DOGE', checkpoint_seq: 59 }
]

describe('expectedFoldRows', function () {
    it('maps sections in wire order and appends the archive row', function () {
        const actual = expectedFoldRows({
            sections,
            archive_count: 1,
            match_batch_seq: 73,
            match_count: 11,
            batch_crc32: 'a1b2c3d4',
            total_chunks: 4
        })

        assert.deepStrictEqual(actual, {
            chainRows: [
                { section_index: 0, chain: 'LTC', checkpoint_seq: 31 },
                { section_index: 1, chain: 'BTC', checkpoint_seq: 47 },
                { section_index: 2, chain: 'DOGE', checkpoint_seq: 59 }
            ],
            archiveRow: {
                section_index: 3,
                match_batch_seq: 73,
                match_count: 11,
                batch_crc32: 'a1b2c3d4',
                total_chunks: 4
            }
        })
    })

    it('maps the same sections and omits the archive row', function () {
        const actual = expectedFoldRows({ sections, archive_count: 0 })

        assert.deepStrictEqual(actual, {
            chainRows: [
                { section_index: 0, chain: 'LTC', checkpoint_seq: 31 },
                { section_index: 1, chain: 'BTC', checkpoint_seq: 47 },
                { section_index: 2, chain: 'DOGE', checkpoint_seq: 59 }
            ],
            archiveRow: null
        })
    })
})
