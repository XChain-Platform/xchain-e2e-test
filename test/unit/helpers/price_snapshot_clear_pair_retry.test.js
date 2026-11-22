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

// clearPair connects with a 5000 ms timeout and retries a failed connect three
// times, so a loaded rail host does not fail a seed step.

const assert     = require('assert')
const proxyquire = require('proxyquire')

// Fake driver whose first `failures` connects reject.
function loadHelper(failures){
    const state = { connects: [], queries: [], ended: 0 }
    const helper = proxyquire('../../helpers/priceSnapshotHelper', {
        mariadb: {
            createConnection: async (params) => {
                state.connects.push(params)
                if (state.connects.length <= failures) throw new Error('connect timeout')
                return {
                    query: async (sql, args) => { state.queries.push({ sql, args }); return { affectedRows: 4 } },
                    end:   async () => { state.ended++ },
                }
            },
            '@noCallThru': true,
        },
    })
    return { helper, state }
}

describe('clearPair connect retry', () => {

    let savedIndexerDb
    beforeEach(() => {
        savedIndexerDb = global.indexerDatabase
        global.indexerDatabase = { host: 'mariadb', port: 3306, dbName: 'XChain_BTC_Regtest_Indexer', user: 'idx', pass: 'p' }
    })
    afterEach(() => { global.indexerDatabase = savedIndexerDb })

    it('exposes a 5000 ms timeout and three retries', () => {
        const { helper } = loadHelper(0)
        assert.strictEqual(helper.CLEAR_PAIR_CONNECT_TIMEOUT_MS, 5000)
        assert.strictEqual(helper.CLEAR_PAIR_CONNECT_RETRIES, 3)
    })

    it('passes the 5000 ms connect timeout to the driver', async () => {
        const { helper, state } = loadHelper(0)
        await helper.clearPair('BTC/USD')
        assert.strictEqual(state.connects.length, 1)
        assert.strictEqual(state.connects[0].connectTimeout, 5000)
    })

    it('succeeds after three failed connects', async () => {
        const { helper, state } = loadHelper(3)
        const removed = await helper.clearPair('BTC/USD')
        assert.strictEqual(removed, 4)
        assert.strictEqual(state.connects.length, 4)
        assert.strictEqual(state.queries.length, 1)
        assert.strictEqual(state.ended, 1)
    })

    it('rethrows the last error after the retries are spent', async () => {
        const { helper, state } = loadHelper(99)
        await assert.rejects(() => helper.clearPair('BTC/USD'), /connect timeout/)
        assert.strictEqual(state.connects.length, 4)
        assert.strictEqual(state.queries.length, 0)
    })
})
