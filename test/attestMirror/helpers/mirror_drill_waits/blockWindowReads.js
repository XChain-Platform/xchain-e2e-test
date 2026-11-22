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
 **********************************************************************
 */

const assert = require('assert')

const { queryDb } = require('./databaseReads')

const { untilOrClearDogeStall } = require('./miningAndStallRecovery')

const { venueTipProbe } = require('./mirrorAndApplyWaits')

/**
 * Wait for a venue indexer to COMMIT a height, clearing the wedge if that is what
 * is holding it.
 *
 * WHY NOT `venue.waitForHeight`. It watches the indexer's own `blocks` table,
 * which is the right thing to watch, and it has no wedge clear: under the roll-call
 * wedge the indexer commits nothing, so that wait spends its entire budget and then
 * reports a height that never moved. Two drills mine long runs and then wait for
 * both nodes to reach a height, which is precisely the combination that forms the
 * wedge and then blocks on it.
 *
 * Watches the same table for the same reason: a health endpoint can report progress
 * a block transaction later rolls back, and after a reorg the committed height is
 * the only honest reading.
 */
async function waitForHeightWithClear (venue, indexerIndex, height, opts) {
    const o = opts || {}
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    const target = Number(height)
    const got = await untilOrClearDogeStall(async () => {
        let at = null
        try {
            const rows = await queryDb(venue, ix.indexerDbName, 'SELECT MAX(block_index) AS h FROM blocks')
            at = (rows && rows[0] && rows[0].h !== null) ? Number(rows[0].h) : null
        } catch (e) { at = null }
        return { ok: at !== null && at >= target, at: at }
    }, {
        timeoutMs: Number(o.timeoutMs) || 30 * 60 * 1000,
        intervalMs: Number(o.intervalMs) || 2000,
        tipProbe: venueTipProbe(venue, indexerIndex),
    })
    assert.ok(got.ok,
        'indexer ' + indexerIndex + ' committed block ' + got.at + ' of ' + target +
        ' before the budget ran out. A height that does not move at all is the wedge rather than ' +
        'slowness, and the clear above says whether one was found.\n' + venue.logTail('indexer' + indexerIndex))
    return got
}

/** One venue indexer's `blocks` rows over a height window, for §4.1 arithmetic. */
async function readBlockWindow (venue, indexerIndex, fromHeight, toHeight) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    return await queryDb(venue, ix.indexerDbName,
        'SELECT block_index, block_time FROM blocks WHERE block_index >= ? AND block_index <= ? ' +
        'ORDER BY block_index ASC',
        [Number(fromHeight), Number(toHeight)])
}

/** The request row as a venue indexer holds it: its status, deadline and block. */
async function readRequestRow (venue, indexerIndex, requestId) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    const rows = await queryDb(venue, ix.indexerDbName,
        'SELECT r.request_id, r.request_status, r.deadline_block, r.provider_id, r.redundancy, ' +
        '       r.fee_amount, r.resolved_block, r.contract_index, r.callback_method, ' +
        '       a.block_index, a.action_index ' +
        'FROM attests r JOIN actions a ON a.action_index = r.action_index ' +
        'WHERE r.request_id = ? AND r.version = 0 LIMIT 1',
        [String(requestId)])
    return (rows && rows[0]) || null
}

module.exports = { waitForHeightWithClear, readBlockWindow, readRequestRow }
