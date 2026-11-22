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

/**
 * Query one of the venue's databases, WITH THAT DATABASE SELECTED.
 *
 * WHY NOT THE FIXTURE'S `queryVenueDb`, which takes a database name. It validates
 * the name and then discards it: the connection is opened with host, port, user
 * and password and no `database`, so every unqualified table reference through it
 * fails with errno 1046, "No database selected". Nothing had noticed because no
 * drill had ever reached one of those reads, and the first thing to reach one was
 * the federation capture, where the failure was then MISCOUNTED as a hub holding
 * no row.
 *
 * Reported to the fixture's owner for `readAppliedResponse` and
 * `readContractState`; the readers below no longer depend on it either way.
 */
async function queryDb (venue, dbName, sql, params, deps) {
    // Injectable so the ONE thing that broke here is assertable without a venue:
    // that the connection is opened WITH a database. That is invisible to every
    // other kind of test and is exactly the class this guards.
    const mariadb = (deps && deps.mariadb) || require('mariadb')
    assert.ok(venue && venue.hubDb, 'mirrorDrillWaits: the venue has no hubDb; it is not started')
    assert.ok(/^[A-Za-z0-9_]+$/.test(String(dbName)),
        'mirrorDrillWaits: refusing an unsafe database identifier ' + dbName)
    let conn = null
    try {
        conn = await mariadb.createConnection({
            host: venue.hubDb.host, port: parseInt(venue.hubDb.port, 10),
            user: venue.hubDb.user, 'password': venue.hubDb.pass,
            database: String(dbName), connectTimeout: 10_000,
        })
        return await conn.query(sql, params || [])
    } finally {
        if (conn) await conn.end().catch(() => {})
    }
}

/**
 * The applied ATTEST v1 row joined to the action it hangs off, read with the
 * database selected. Same shape the fixture's reader returns.
 */
async function readAppliedResponse (venue, indexerIndex, requestId) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    const rows = await queryDb(venue, ix.indexerDbName,
        // NO a.tx_hash AND NO a.source: neither column exists. `actions` spells it
        // `source_id`, and the transaction hash lives on `transactions` alone, which
        // a mirror-applied action deliberately has no row in. This is the SECOND
        // copy of this query in the drill tree, and fixing only the other one left
        // every caller that comes through the waits helper still running the
        // broken text.
        'SELECT a.action_index, a.block_index, a.tx_index, a.source_id, ' +
        '       r.request_id, r.response_status, r.response_payload, r.status_id, ' +
        '       r.response_hash, r.request_status, ' +
        '       r.callback_execute_action_index ' +
        'FROM attests r JOIN actions a ON a.action_index = r.action_index ' +
        'WHERE r.request_id = ? AND r.version = 1 ' +
        'ORDER BY a.action_index ASC LIMIT 1',
        [String(requestId)])
    return (rows && rows[0]) || null
}

/** Every state key a contract carries on one venue indexer, latest value per key. */
async function readContractState (venue, indexerIndex, contractIndex) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    const rows = await queryDb(venue, ix.indexerDbName,
        'SELECT cs.state_key, cs.state_value FROM contract_state cs ' +
        'INNER JOIN (SELECT MAX(id) AS max_id FROM contract_state ' +
        '            WHERE contract_index = ? GROUP BY state_key) latest ' +
        '  ON latest.max_id = cs.id',
        [Number(contractIndex)])
    const out = {}
    for (const r of rows || []) out[String(r.state_key)] = r.state_value
    return out
}

/**
 * EVERY v1 row a venue indexer holds for one request, with its verdict resolved.
 *
 * WHY THIS EXISTS BESIDE `readAppliedResponse`. Above the activation height a
 * request can end up with TWO v1 rows: the audit row a rejected on-chain v1
 * leaves behind, and the row the mirror applier writes. The fixture's reader takes
 * the lowest `action_index` and returns one row, which is the on-chain one
 * whenever a stale hub broadcast first, so a drill that asserted "the mirror row
 * applied" through it would be reading the rejection. This returns both, in
 * action order, with `index_statuses.status` joined in so the verdict string is
 * readable, and the caller decides which row is which.
 *
 * The discriminator between them is not the status text but `tx_index`: the
 * on-chain row has a transaction position, the synthesized one is NULL there.
 */
async function readResponseRows (venue, indexerIndex, requestId) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillWaits: no indexer ' + indexerIndex)
    return await queryDb(venue, ix.indexerDbName,
        // a.tx_hash removed: the column does not exist, and a tx-less action has no
        // transactions row to carry one. The discriminator this reader documents is
        // tx_index, which does exist and is NULL exactly for the synthesized row.
        'SELECT a.action_index, a.block_index, a.tx_index, r.response_hash, ' +
        '       r.request_id, r.response_status, r.response_payload, r.validator_signatures, ' +
        '       r.callback_execute_action_index, r.batch_action_index, s.status AS verdict ' +
        'FROM attests r ' +
        'JOIN actions a ON a.action_index = r.action_index ' +
        'LEFT JOIN index_statuses s ON s.id = r.status_id ' +
        'WHERE r.request_id = ? AND r.version = 1 ' +
        'ORDER BY a.action_index ASC',
        [String(requestId)])
}

module.exports = { queryDb, readAppliedResponse, readContractState, readResponseRows }
