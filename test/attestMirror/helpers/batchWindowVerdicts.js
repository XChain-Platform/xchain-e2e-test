'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 ********************************************************************/

function sameNumber (left, right) {
    const leftNumber = Number(left)
    const rightNumber = Number(right)
    return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber
}

function headsForWindow (actions, windowStart) {
    return actions.filter((action) => Number(action.version) === 5 &&
        sameNumber(action.batch_window_start, windowStart))
}

function oneValidHeadVerdict (actions, windowStart) {
    const heads = headsForWindow(actions, windowStart)
    const validHeads = heads.filter((head) => String(head.verdict) === 'valid')
    return {
        ok: validHeads.length === 1,
        heads: heads,
        valid: validHeads[0] || null,
        duplicates: validHeads.slice(1),
    }
}

function emptyWindowVerdict (markers, actions) {
    const candidates = markers.filter((marker) => String(marker.status) === 'skipped' &&
        Number(marker.row_count) === 0)
    let fallback = { ok: false, marker: null, heads: [] }

    for (const marker of candidates) {
        const heads = headsForWindow(actions, marker.window_start)
        if (fallback.marker === null) fallback = { ok: false, marker: marker, heads: heads }
        if (heads.length === 0) return { ok: true, marker: marker, heads: heads }
    }

    return fallback
}

module.exports = { oneValidHeadVerdict, emptyWindowVerdict }
