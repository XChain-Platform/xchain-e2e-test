// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')

describe('SMOKE: Database Schema', () => {
    it('should be able to query the indexer database', async () => {
        const result = await indexerDatabase.ping()
        assert(result, 'Database ping (SELECT 1+1) should succeed')
    })

    it('should have core indexer tables', async () => {
        let connection = await indexerDatabase.getConnection()
        try {
            const rows = await connection.query('SHOW TABLES')
            assert(rows.length > 0, 'Database should have at least one table')

            const tableNames = rows.map(row => Object.values(row)[0].toLowerCase())
            const requiredTables = ['issues', 'sends', 'credits', 'debits']
            for (const table of requiredTables) {
                assert(tableNames.includes(table), 'Missing required table: ' + table)
            }
        } finally {
            connection.release()
        }
    })
})
