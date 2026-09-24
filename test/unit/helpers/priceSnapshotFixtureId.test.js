'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Fixture price rows must never sit on an id the hub's next round arrives with. The
// indexer's hub_db_sync keeps the hub's wire id for price_snapshots and upserts ON
// DUPLICATE KEY UPDATE, so a fixture that took MAX(id)+1 had its price rewritten in
// place by the next mirrored round while it kept its sentinel round (MT3 run
// 35925455269 on DOGE, and the LTC DEPLOY that owed 7.8 LTC).

const assert     = require('assert')
const fs         = require('fs')
const path       = require('path')
const proxyquire = require('proxyquire')

function loadHelper(){
    const seen = []
    const helper = proxyquire('../../helpers/priceSnapshotHelper', {
        mariadb: {
            createConnection: async () => ({
                query: async (sql, args) => { seen.push({ sql: String(sql), args }); return { affectedRows: 1 } },
                end:   async () => {},
            }),
            '@noCallThru': true,
        },
    })
    return { helper, seen }
}

describe('priceSnapshotHelper fixture ids', () => {
    let savedIndexerDb
    beforeEach(() => {
        savedIndexerDb = global.indexerDatabase
        global.indexerDatabase = { host: 'mariadb', port: 3306, dbName: 'XChain_DOGE_Regtest_Indexer', user: 'idx', pass: 'p' }
    })
    afterEach(() => { global.indexerDatabase = savedIndexerDb })

    it('inserts at an explicit id at or above the floor, never by AUTO_INCREMENT', async () => {
        const { helper, seen } = loadHelper()
        await helper.seedSnapshot({ coinPair: 'DOGE/USD', price: '100000.00000000', blockTimestamp: 1790201516, roundNumber: 888100002 })
        const insert = seen.find(q => /^INSERT/i.test(q.sql.trim()))
        assert.ok(insert, 'seedSnapshot must insert: ' + JSON.stringify(seen))
        assert.match(insert.sql, /\(id, round_number, coin_pair,/)
        assert.match(insert.sql, /GREATEST\(COALESCE\(MAX\(id\), 0\) \+ 1, \?\)/)
        assert.strictEqual(insert.args[0], helper.FIXTURE_ID_FLOOR)
        assert.deepStrictEqual(insert.args.slice(1), [888100002, 'DOGE/USD', '100000.00000000', 0, 1790201516])
        assert.ok(!/ON DUPLICATE KEY/i.test(insert.sql),
            'an upsert would keep an old row on its hub-reachable id')
    })

    it('replaces an existing row for the same round and pair by deleting it first', async () => {
        const { helper, seen } = loadHelper()
        await helper.seedSnapshot({ coinPair: 'DOGE/USD', price: '100000.00000000', blockTimestamp: 1, roundNumber: 888100012, referenceBlock: 7 })
        const insertAt = seen.findIndex(q => /^INSERT/i.test(q.sql.trim()))
        const deleteAt = seen.findIndex(q => /^DELETE/i.test(q.sql.trim()))
        assert.ok(deleteAt >= 0 && deleteAt < insertAt, 'the delete must precede the insert')
        assert.deepStrictEqual(seen[deleteAt].args, [888100012, 'DOGE/USD'])
        assert.strictEqual(seen[insertAt].args[4], 7, 'referenceBlock is carried through')
    })

    it('puts the floor far above any id a hub reaches', () => {
        const { helper } = loadHelper()
        // About 37 rows per ten-minute round: a century of rounds is ~2e8 ids.
        assert.ok(helper.FIXTURE_ID_FLOOR >= 1e12)
        assert.ok(Number.isSafeInteger(helper.FIXTURE_ID_FLOOR + 1e9), 'ids must stay exact in JS')
    })

    it('is the insert every direct indexer-side fixture writer uses', () => {
        for (const rel of ['../../actions/native_fee_live.test.js', '../../actions/native_fee_dispenser.test.js']) {
            const src = fs.readFileSync(path.join(__dirname, rel), 'utf8')
            assert.ok(/FIXTURE_INSERT_SQL/.test(src), rel + ' must insert through FIXTURE_INSERT_SQL')
            assert.ok(!/INSERT INTO price_snapshots/.test(src), rel + ' must not carry its own AUTO_INCREMENT insert')
        }
    })
})
