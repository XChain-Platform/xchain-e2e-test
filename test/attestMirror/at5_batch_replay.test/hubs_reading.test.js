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

// The hubs reading and the DOGE reconcile-indexer wiring.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const { queryVenueDb } = require('../helpers/mirrorDrillFixture')
const { jsonSafe } = require('../helpers/mirrorDrillWaits')
const { readHubsReading } = require('../helpers/hubsReading')
const { buildAt5DogeIndexerConfig } = require('../helpers/at5ResponseProvider')


// True once a hub other than the window's publishers shows it learned the window
// landed: a `landed` marker for it, or a chain reconcile that found a landed window.
// The same rule the platform's judge-attest-reconcile.js grades; this only decides
// when the reading is worth keeping.
function reconcileSeen (reading, windowStart) {
    const forWindow = (entry) => entry.markers.filter((m) => m.window_start === Number(windowStart))
    const publishers = reading.filter((e) => forWindow(e).some((m) => m.status === 'intent' || m.status === 'sent'))
    const others = reading.filter((e) => !publishers.includes(e))
    return others.length > 0 && others.every((e) => forWindow(e).some((m) => m.status === 'landed') ||
        Number((e.stats || {}).chainReconcileLandedWindows) > 0)
}

/**
 * AQ-ACC's hub reading, taken while the venue is still up because it dies with the
 * leg: each hub's batch publisher stats (from its `health` answer) and its markers,
 * polled for up to ten minutes until a non-publishing hub shows it saw the landed
 * window, then written as `at5-hubs-reading.json` beside the venue logs. It never
 * fails the case: the leg's own assertions stay the verdict, and the reading is
 * judged afterwards from the uploaded logs.
 */
async function recordHubsReading (venue, marker, readMarkers, nudgeDoge) {
    const dir = process.env.ATTEST_VENUE_LOG_DIR
    if (!dir) return
    const file = path.join(dir, 'at5-hubs-reading.json')
    try {
        let reading = []
        const deadline = Date.now() + 10 * 60 * 1000
        do {
            await nudgeDoge()
            reading = await readHubsReading(venue.hubs, await readMarkers())
            fs.writeFileSync(file, JSON.stringify(reading, null, 2) + '\n')
            if (reconcileSeen(reading, marker.window_start)) break
            await new Promise((resolve) => setTimeout(resolve, 15000))
        } while (Date.now() < deadline)
        console.log('AT5 READING: hubs reading for window ' + marker.window_start + ' written to ' + file +
            ' (reconcile seen: ' + reconcileSeen(reading, marker.window_start) + '): ' + JSON.stringify(reading))
    } catch (e) {
        console.log('AT5 READING: could not take the hubs reading: ' + (e && e.message))
    }
}

/**
 * Point every publisher hub at the attached DOGE venue indexer through the
 * hub's public config-consensus RPC. The attached reader does not exist until
 * after the owner hubs start, so this coordinate cannot be part of hubExtraEnv.
 * Waiting for every hub database proves the config committed federation-wide
 * before a response window can close and ask the chain what already landed.
 */
async function configureDogeReconcileIndexer (venue, dogeVenue) {
    const indexer = dogeVenue && dogeVenue.indexers && dogeVenue.indexers[0]
    assert.ok(indexer && indexer.apiUrl, 'AT5: attached DOGE venue has no indexer API coordinate')
    const config = buildAt5DogeIndexerConfig(indexer.apiUrl, venue.network)
    const moduleConfig = config.dogecoin[venue.network]['xchain-indexer']
    let result = null
    for (const hub of venue.hubs) {
        result = await hub.connector['_call']({
            jsonrpc: '2.0', id: Date.now(), method: 'updateconfig',
            params: { config: config },
        })
        if (result && String(result.status) === 'success') break
    }
    assert.ok(result && String(result.status) === 'success',
        'AT5: hub config consensus refused the attached DOGE indexer: ' + jsonSafe(result))

    const deadline = Date.now() + 60_000
    let missing = venue.hubs.map((hub) => hub.index)
    while (missing.length > 0 && Date.now() < deadline) {
        missing = []
        for (const hub of venue.hubs) {
            const rows = await queryVenueDb(venue, hub.dbName,
                'SELECT param_name, param_value FROM configs ' +
                'WHERE coin = ? AND network = ? AND module = ?',
                ['dogecoin', venue.network, 'xchain-indexer'])
            const config = Object.fromEntries(rows.map((row) => [String(row.param_name), String(row.param_value)]))
            if (config.host !== moduleConfig.host || config.port !== moduleConfig.port) missing.push(hub.index)
        }
        if (missing.length > 0) await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.deepStrictEqual(missing, [],
        'AT5: attached DOGE indexer config did not reach hub(s) ' + missing.join(', '))
    console.log('AT5: attached DOGE venue indexer committed to all ' + venue.hubs.length +
        ' publisher hubs for chain reconcile')
}

module.exports = { reconcileSeen, recordHubsReading, configureDogeReconcileIndexer }
