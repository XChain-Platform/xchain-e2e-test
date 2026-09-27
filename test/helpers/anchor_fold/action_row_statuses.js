'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

function isPresent(value) {
    return value !== null && value !== undefined
}

function statusesForAction(rows, actionIndex) {
    const matchingRows = rows.filter((row) => (
        Number(row.action_index) === Number(actionIndex)
    ))
    const chainStatuses = matchingRows
        .filter((row) => isPresent(row.chain))
        .map((row) => row.status)
    const archiveStatuses = matchingRows
        .filter((row) => isPresent(row.match_batch_seq) && Number(row.version) !== 2)
        .map((row) => row.status)

    return { chainStatuses, archiveStatuses }
}

module.exports = { statusesForAction }
