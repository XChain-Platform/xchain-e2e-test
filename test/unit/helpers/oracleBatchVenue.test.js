'use strict'

// Copyright © 2025–2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const {
    applyPriceCapabilityStakes,
    removePriceCapabilityStakes,
    CANONICAL_REORG_BUFFER
} = require('../../helpers/oracleBatchVenue')

function queryStub(options) {
    options = options || {}
    const calls = []
    let pubkeyIndex = 0
    let addressIndex = 0
    const query = async (sql, args) => {
        calls.push({ sql, args })
        if (sql.includes('FROM index_statuses')) return [{ id: 7 }]
        if (sql.startsWith('INSERT IGNORE INTO index_pubkeys')) return { affectedRows: 1 }
        if (sql.startsWith('SELECT id FROM index_pubkeys')) return [{ id: 101 + pubkeyIndex++ }]
        if (sql.startsWith('INSERT IGNORE INTO index_addresses')) {
            const affectedRows = options.preExisting ? 0 : 1
            return { affectedRows: affectedRows }
        }
        if (sql.startsWith('SELECT id FROM index_addresses')) {
            const id = options.preExisting ? 55 : 9100000000000 + addressIndex
            addressIndex++
            return [{ id: id }]
        }
        return { affectedRows: 1 }
    }
    return { query, calls }
}

describe('oracleBatchVenue price capability stakes', function () {
    it('writes distinct source ids and records fallback source ownership', async function () {
        const stub = queryStub()
        const rows = [
            { snapshotBlock: 100, pubkey: 'aa', source: 'source-a', amount: '20' },
            { snapshotBlock: 100, pubkey: 'bb', source: '', amount: '30' }
        ]

        const written = await applyPriceCapabilityStakes(stub.query, rows)

        assert.deepStrictEqual(written, [
            {
                actionIndex: 9000000000000,
                pubkeyId: 101,
                pubkey: 'aa',
                sourceId: 9100000000000,
                sourceAddress: 'source-a',
                mintedSourceId: 9100000000000
            },
            {
                actionIndex: 9000000000001,
                pubkeyId: 102,
                pubkey: 'bb',
                sourceId: 9100000000001,
                sourceAddress: 'at2-price-source-1',
                mintedSourceId: 9100000000001
            }
        ])

        const addressInserts = stub.calls.filter((call) =>
            call.sql.startsWith('INSERT IGNORE INTO index_addresses'))
        assert.deepStrictEqual(addressInserts.map((call) => call.args), [
            [9100000000000, 'source-a', 100 - 3 * CANONICAL_REORG_BUFFER],
            [9100000000001, 'at2-price-source-1', 100 - 3 * CANONICAL_REORG_BUFFER]
        ])

        const stakeInserts = stub.calls.filter((call) => call.sql.startsWith('INSERT INTO stakes'))
        assert.strictEqual(stakeInserts.length, 2)
        assert.match(stakeInserts[0].sql, /VALUES \(\?, \?, 1, \?, \?, \?, \?, \?, \?\)/)
        assert.match(stakeInserts[0].sql, /ON DUPLICATE KEY UPDATE source_id = VALUES\(source_id\)/)
        assert.deepStrictEqual(stakeInserts.map((call) => call.args.slice(0, 3)), [
            [9000000000000, 9100000000000, 101],
            [9000000000001, 9100000000001, 102]
        ])
    })

    it('reuses a pre-existing source without claiming it for cleanup', async function () {
        const stub = queryStub({ preExisting: true })

        const written = await applyPriceCapabilityStakes(stub.query, [
            { snapshotBlock: 100, pubkey: 'aa', source: 'existing-source', amount: '20' }
        ])

        assert.strictEqual(written[0].sourceId, 55)
        assert.strictEqual(written[0].sourceAddress, 'existing-source')
        assert.strictEqual(written[0].mintedSourceId, null)
        const stakeInsert = stub.calls.find((call) => call.sql.startsWith('INSERT INTO stakes'))
        assert.strictEqual(stakeInsert.args[1], 55)
    })

    it('removes only source rows minted by the venue', async function () {
        const calls = []
        const query = async (sql, args) => { calls.push({ sql, args }) }
        const written = [
            {
                actionIndex: 9000000000000,
                pubkeyId: 101,
                sourceAddress: 'minted-source',
                mintedSourceId: 9100000000000
            },
            {
                actionIndex: 9000000000001,
                pubkeyId: 102,
                sourceAddress: 'existing-source',
                mintedSourceId: null
            }
        ]

        assert.strictEqual(await removePriceCapabilityStakes(query, written), 2)
        const stakeDeletes = calls.filter((call) => call.sql.startsWith('DELETE FROM stakes'))
        const addressDeletes = calls.filter((call) => call.sql.startsWith('DELETE FROM index_addresses'))
        assert.deepStrictEqual(stakeDeletes.map((call) => call.args), [
            [9000000000000, 101],
            [9000000000001, 102]
        ])
        assert.deepStrictEqual(addressDeletes.map((call) => call.args), [
            [9100000000000, 'minted-source']
        ])
    })
})
