'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto')

function isPresent(value) {
    return value !== null && value !== undefined
}

function txHashKey(value) {
    if (Buffer.isBuffer(value)) return 'buffer:' + value.toString('hex')
    if (typeof value === 'bigint') return 'bigint:' + value.toString()
    return typeof value + ':' + String(value)
}

function summarizeAnchorCycle(rows) {
    const chainRows = rows.filter((row) => isPresent(row.chain))
    const archiveRows = rows.filter((row) => (
        isPresent(row.match_batch_seq) && Number(row.version) !== 2
    ))

    return {
        txCount: new Set(rows.map((row) => txHashKey(row.tx_hash))).size,
        chainSections: chainRows.length,
        archiveSections: archiveRows.length,
        chains: chainRows.map((row) => row.chain).sort()
    }
}

function compareNullableNumeric(left, right) {
    if (left == null && right == null) return 0
    if (left == null) return -1
    if (right == null) return 1
    return Number(left) - Number(right)
}

function compareRows(left, right) {
    return compareNullableNumeric(left.action_index, right.action_index)
        || compareNullableNumeric(left.section_index, right.section_index)
}

function jsonValue(value) {
    if (Buffer.isBuffer(value)) return value.toString('hex')
    if (typeof value === 'bigint') return value.toString()
    return value
}

function serializeRow(row, columns) {
    const pairs = []
    for (const column of columns) {
        const value = JSON.stringify(jsonValue(row[column]))
        if (value !== undefined) pairs.push(JSON.stringify(column) + ':' + value)
    }
    return '{' + pairs.join(',') + '}'
}

function anchorRowsDigest(rows, columns) {
    const selectedColumns = columns || Object.keys(rows[0] || {}).sort()
    const serializedRows = rows.slice().sort(compareRows)
        .map((row) => serializeRow(row, selectedColumns))
    const serialized = '[' + serializedRows.join(',') + ']'
    return crypto.createHash('sha256').update(serialized).digest('hex')
}

module.exports = { summarizeAnchorCycle, anchorRowsDigest }
