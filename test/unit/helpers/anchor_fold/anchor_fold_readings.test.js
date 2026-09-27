'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const crypto = require('crypto')
const {
    summarizeAnchorCycle,
    anchorRowsDigest
} = require('../../../helpers/anchor_fold/anchor_fold_readings')

function foldedRows() {
    return [
        { tx_hash: 'folded', action_index: 20, section_index: 0, version: 3, chain: 'LTC', match_batch_seq: null },
        { tx_hash: 'folded', action_index: 20, section_index: 1, version: 3, chain: 'BTC', match_batch_seq: null },
        { tx_hash: 'folded', action_index: 20, section_index: 2, version: 3, chain: 'DOGE', match_batch_seq: null },
        { tx_hash: 'folded', action_index: 20, section_index: 3, version: 3, chain: null, match_batch_seq: 42 }
    ]
}

describe('anchor fold readings', function () {
    it('summarizes one folded transaction with chain and archive sections', function () {
        assert.deepStrictEqual(summarizeAnchorCycle(foldedRows()), {
            txCount: 1,
            chainSections: 3,
            archiveSections: 1,
            chains: ['BTC', 'DOGE', 'LTC']
        })
    })

    it('does not count a version 2 chunk as an archive section', function () {
        const rows = foldedRows().concat({
            tx_hash: 'folded',
            action_index: 20,
            section_index: 4,
            version: '2',
            chain: null,
            match_batch_seq: 42
        })

        assert.strictEqual(summarizeAnchorCycle(rows).archiveSections, 1)
    })

    it('counts two unfolded transactions', function () {
        const rows = [
            { tx_hash: 'first', chain: 'BTC', match_batch_seq: null, version: 0 },
            { tx_hash: 'second', chain: 'DOGE', match_batch_seq: null, version: 0 }
        ]

        assert.strictEqual(summarizeAnchorCycle(rows).txCount, 2)
    })

    it('produces the same digest when rows are reordered', function () {
        const rows = foldedRows()
        const reordered = [rows[3], rows[1], rows[0], rows[2]]

        assert.strictEqual(anchorRowsDigest(rows), anchorRowsDigest(reordered))
    })

    it('changes the digest when a projected field changes', function () {
        const rows = foldedRows()
        const changed = rows.map((row) => ({ ...row }))
        changed[1].chain = 'BCH'

        assert.notStrictEqual(anchorRowsDigest(rows), anchorRowsDigest(changed))
    })

    it('honours an explicit ordered column list', function () {
        const rows = [{
            tx_hash: 'folded',
            action_index: 20,
            section_index: 0,
            chain: 'BTC',
            ignored: 'first'
        }]
        const expectedJson = '[{"chain":"BTC","tx_hash":"folded"}]'
        const expected = crypto.createHash('sha256').update(expectedJson).digest('hex')

        assert.strictEqual(anchorRowsDigest(rows, ['chain', 'tx_hash']), expected)
        rows[0].ignored = 'second'
        assert.strictEqual(anchorRowsDigest(rows, ['chain', 'tx_hash']), expected)
    })

    it('preserves explicit ordering for integer-like column names', function () {
        const rows = [{ 2: 'two', 10: 'ten' }]
        const expectedJson = '[{"10":"ten","2":"two"}]'
        const expected = crypto.createHash('sha256').update(expectedJson).digest('hex')

        assert.strictEqual(anchorRowsDigest(rows, ['10', '2']), expected)
    })

    it('serializes Buffer and BigInt values as strings', function () {
        const rows = [{ action_index: 1, section_index: null, bytes: Buffer.from('abc'), count: 9n }]
        const expectedJson = '[{"bytes":"616263","count":"9"}]'
        const expected = crypto.createHash('sha256').update(expectedJson).digest('hex')

        assert.strictEqual(anchorRowsDigest(rows, ['bytes', 'count']), expected)
    })

    it('sorts numeric indexes with nulls first without mutating the rows', function () {
        const rows = [
            { action_index: '10', section_index: 1, value: 'last' },
            { action_index: null, section_index: 8, value: 'first' },
            { action_index: 2, section_index: null, value: 'middle' }
        ]
        const originalOrder = rows.slice()
        const expectedJson = '[{"value":"first"},{"value":"middle"},{"value":"last"}]'
        const expected = crypto.createHash('sha256').update(expectedJson).digest('hex')

        assert.strictEqual(anchorRowsDigest(rows, ['value']), expected)
        assert.deepStrictEqual(rows, originalOrder)
    })
})
