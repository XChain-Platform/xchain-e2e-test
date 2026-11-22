'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************/

const assert = require('assert')

async function queryVenueDb (venue, dbName, sql, params) {
    const mariadb = require('mariadb')
    assert.ok(venue && venue.hubDb, 'mirrorDrillFixture: the venue has no hubDb; it is not started')
    assert.ok(/^[A-Za-z0-9_]+$/.test(String(dbName)),
        'mirrorDrillFixture: refusing an unsafe database identifier ' + dbName)
    let conn = null
    try {
        conn = await mariadb.createConnection({
            host: venue.hubDb.host,
            port: parseInt(venue.hubDb.port, 10),
            user: venue.hubDb.user,
            password:
                venue.hubDb.pass,
            connectTimeout: 10_000,
            database: String(dbName),
        })
        return await conn.query(sql, params || [])
    } finally {
        if (conn) await conn.end().catch(() => {})
    }
}

async function readAppliedResponse (venue, indexerIndex, requestId) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillFixture: no indexer ' + indexerIndex)
    const rows = await queryVenueDb(venue, ix.indexerDbName,
        'SELECT a.action_index, a.block_index, a.tx_index, a.source_id, ' +
        '       r.request_id, r.response_status, r.response_payload, r.request_status, ' +
        '       r.status_id, ' +
        '       r.response_hash, r.callback_execute_action_index ' +
        'FROM attests r JOIN actions a ON a.action_index = r.action_index ' +
        'WHERE r.request_id = ? AND r.version = 1 ' +
        'ORDER BY a.action_index ASC LIMIT 1',
        [String(requestId)])
    return (rows && rows[0]) || null
}

async function readContractState (venue, indexerIndex, contractIndex) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillFixture: no indexer ' + indexerIndex)
    const rows = await queryVenueDb(venue, ix.indexerDbName,
        'SELECT cs.state_key, cs.state_value FROM contract_state cs ' +
        'INNER JOIN (SELECT MAX(id) AS max_id FROM contract_state ' +
        '            WHERE contract_index = ? GROUP BY state_key) latest ' +
        '  ON latest.max_id = cs.id',
        [Number(contractIndex)])
    const out = {}
    for (const r of rows || []) out[String(r.state_key)] = r.state_value
    return out
}

module.exports = { queryVenueDb, readAppliedResponse, readContractState }
