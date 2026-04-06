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
