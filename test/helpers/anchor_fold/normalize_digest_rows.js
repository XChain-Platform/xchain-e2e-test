'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

function normalizeAnchorRowsForDigest(rows) {
    return rows.map((row) => {
        const normalized = { ...row }
        delete normalized.id
        delete normalized.created_at
        delete normalized.updated_at
        return normalized
    })
}

module.exports = { normalizeAnchorRowsForDigest }
