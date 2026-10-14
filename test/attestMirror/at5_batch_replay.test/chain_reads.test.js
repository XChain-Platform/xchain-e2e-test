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

// The reads the drill makes against the hubs and the DOGE venue indexer.

const { queryVenueDb } = require('../helpers/mirrorDrillFixture')
const { mineDogeBlocks } = require('../helpers/mirrorDrillWaits')
const { BATCH_HEAD_VERSION, BATCH_CONTINUATION_VERSION } = require('./config.test.js')


/** Every published-window marker any hub holds, with the hub that holds it. */
async function readMarkers (venue) {
    const out = []
    for (const hub of venue.hubs) {
        const rows = await queryVenueDb(venue, hub.dbName,
            'SELECT network, window_start, window_end, batch_key, row_count, txid, status ' +
            'FROM attest_published_batches ORDER BY window_start ASC').catch(() => [])
        for (const r of rows) out.push(Object.assign({ hub: hub.index }, r))
    }
    return out
}

/**
 * Mine one DOGE block, because a broadcast batch is not a landed batch.
 *
 * THE WINDOW CLOSES ON WALL CLOCK, so the publisher fires without any help. The
 * TRANSACTION it broadcasts is a different matter: nothing mines DOGE on this
 * venue, so a v5 sits unconfirmed in the mempool forever and every read below
 * reports an empty chain. The stalled-tip clear in the shared waits helper does
 * not cover this, and correctly so: it mines DOGE only when the BTC indexer is
 * stuck behind its own decoder, which an unconfirmed DOGE transaction never
 * causes.
 *
 * Mining here cannot move what this drill measures. The batch window is keyed on
 * the SIGNED effective time, not on DOGE height, so DOGE blocks cannot shift a
 * window boundary; they only let a transaction confirm. That is why this is one
 * block per poll rather than the miner's mine-empty heartbeat, which both lanes
 * agreed to leave off.
 */
async function nudgeDoge () {
    await mineDogeBlocks(1).catch((e) => {
        console.log('AT5: could not mine DOGE (' + (e && e.message) + '), and a broadcast batch ' +
            'cannot confirm without it')
    })
}

/**
 * The DOGE-side ATTEST batch actions, read on the standing DOGE indexer.
 *
 * There is no generic `query` on the harness Database, and no helper anywhere
 * reads an action by version, so this is the first `version IN (5, 6)` reader in
 * the tree: connection out, connection released in a finally, exactly as
 * `src/db.js` does it everywhere else. `at` is quoted because it is a reserved
 * word in some MariaDB versions and an unquoted alias would fail only there.
 */
async function readDogeBatchActions (dogeVenue) {
    // Read on the VENUE's DOGE indexer (see the before-hook), never the standing
    // one: only a node mirroring the venue federation holds the capability
    // snapshot the verdict is judged against.
    if (!dogeVenue || !dogeVenue.indexers[0]) return []
    try {
        return await queryVenueDb(dogeVenue, dogeVenue.indexers[0].indexerDbName,
            'SELECT a.action_index, a.block_index, `at`.version, `at`.batch_window_start, ' +
            '       `at`.batch_window_end, `at`.batch_row_count, `at`.batch_chunk_index, ' +
            '       `at`.batch_total_chunks, s.status AS verdict ' +
            'FROM attests `at` JOIN actions a ON a.action_index = `at`.action_index ' +
            'LEFT JOIN index_statuses s ON s.id = `at`.status_id ' +
            'WHERE `at`.version IN (?, ?) ORDER BY a.action_index ASC',
            [BATCH_HEAD_VERSION, BATCH_CONTINUATION_VERSION])
    } catch (e) {
        // Reported rather than swallowed: an unreadable DOGE side is a different
        // failure from an empty one, and the caller's assertion prints this.
        console.log('AT5: could not read DOGE batch actions: ' + (e && e.message))
        return []
    }
}

module.exports = { readMarkers, nudgeDoge, readDogeBatchActions }
