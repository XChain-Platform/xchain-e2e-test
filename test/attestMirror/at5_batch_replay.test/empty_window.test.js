'use strict'

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

// The empty-window case. See ../at5_batch_replay.test.js.

const assert = require('assert')

const { untilOrClearDogeStall, venueTipProbe, jsonSafe } = require('../helpers/mirrorDrillWaits')
const { emptyWindowVerdict } = require('../helpers/batchWindowVerdicts')
const { readMarkers, nudgeDoge, readDogeBatchActions } = require('./chain_reads.test.js')


/** A fresh empty window is recorded `skipped`; returns its marker. */
async function awaitSkippedWindow (venue) {
    // Start beyond every window already observed, so the marker belongs to a
    // quiet window created by this case rather than venue setup or the request case.
    const before = await readMarkers(venue)
    const newestBefore = before.reduce((latest, m) =>
        Math.max(latest, Number(m.window_start)), Number.NEGATIVE_INFINITY)
    const skipped = await untilOrClearDogeStall(async () => {
        const markers = await readMarkers(venue)
        const hit = markers.filter((m) => Number(m.window_start) > newestBefore &&
            Number(m.row_count) === 0 && String(m.status) === 'skipped')
        return { ok: hit.length > 0, hit: hit, markers: markers }
    }, { timeoutMs: 30 * 60 * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
    assert.ok(skipped.ok,
        'no hub recorded a fresh empty window as skipped. Markers: ' + jsonSafe(skipped.markers))
    return skipped.hit[0]
}

/** After a further window closes, the skipped one still has no v5 head. */
async function assertNoHead (venue, dogeVenue, marker) {
    const quiet = await untilOrClearDogeStall(async () => {
        const markers = await readMarkers(venue)
        const later = markers.filter((m) => Number(m.window_start) >= Number(marker.window_end))
        if (later.length === 0) return { ok: false, markers: markers }
        await nudgeDoge()
        const actions = await readDogeBatchActions(dogeVenue)
        const sameWindow = markers.filter((m) =>
            Number(m.window_start) === Number(marker.window_start))
        return {
            ok: true,
            markers: markers,
            actions: actions,
            verdict: emptyWindowVerdict(sameWindow, actions),
        }
    }, { timeoutMs: 30 * 60 * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
    assert.ok(quiet.ok,
        'no further window closed after skipped window ' + marker.window_start +
        '. Markers seen: ' + jsonSafe(quiet.markers))
    assert.ok(quiet.verdict.ok,
        'skipped empty window ' + marker.window_start + ' published a v5 head after a further ' +
        'window closed. Heads seen: ' + jsonSafe(quiet.verdict.heads) +
        '. All batch actions seen: ' + jsonSafe(quiet.actions))
    console.log('AT5: empty window ' + marker.window_start + ' stayed skipped with no v5 head')
}

async function runEmptyWindowCase (ctx) {
    const marker = await awaitSkippedWindow(ctx.venue)
    await assertNoHead(ctx.venue, ctx.dogeVenue, marker)
}

module.exports = { runEmptyWindowCase }
