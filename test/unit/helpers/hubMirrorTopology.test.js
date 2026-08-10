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

// . The FIAT price fixtures can be pointed at three different databases,
// and the failure mode of confusing any two of them is a dispense settling
// 'invalid: no matching oracle price', which reads as a consensus bug rather
// than a fixture one. These cases pin the resolution for every topology the
// stack can actually be in.
//
// The load-bearing one is `read target is the hub DB, not the local DB`: the
// indexer routes every price lookup through `db.indexer.hubDb ? hubDb : db`
// (xchain-indexer utility.js), so once HUB_DB_NAME is set, waiting on the
// indexer's own database watches a table that never receives the mirrored row.

const assert = require('assert')

const TOPOLOGY_PATH = require.resolve('../../helpers/hubMirrorTopology')

const ENV_KEYS = [
    'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS',
    'HUB_SOURCE_DB_HOST', 'HUB_SOURCE_DB_PORT', 'HUB_SOURCE_DB_NAME',
    'HUB_SOURCE_DB_USER', 'HUB_SOURCE_DB_PASS'
]

// The suite's stand-in for the indexer's own connection, which the helpers read
// off the global rather than the environment.
const LOCAL = { host: 'mariadb', port: 3306, dbName: 'XChain_BTC_Regtest_Indexer', user: 'idx', pass: 'p' }

function freshTopology(){
    delete require.cache[TOPOLOGY_PATH]
    return require(TOPOLOGY_PATH)
}

describe('hubMirrorTopology ', () => {
    const savedEnv = {}
    let savedIndexerDb

    beforeEach(() => {
        for (const k of ENV_KEYS){ savedEnv[k] = process.env[k]; delete process.env[k] }
        savedIndexerDb = global.indexerDatabase
        global.indexerDatabase = Object.assign({}, LOCAL)
    })

    afterEach(() => {
        for (const k of ENV_KEYS){
            if (savedEnv[k] === undefined) delete process.env[k]
            else process.env[k] = savedEnv[k]
        }
        global.indexerDatabase = savedIndexerDb
    })

    // Topology 1: the devhost regtest stack as it stands today. No hub DB is
    // configured, so the indexer reads its own tables and seeding writes there.
    // Every mirror-aware branch must be inert here, or this change would alter a
    // suite that currently passes.
    describe('single-host (no hub DB configured)', () => {
        it('resolves seed and read to the indexer\'s own database', () => {
            const t = freshTopology()
            assert.deepStrictEqual(t.seedParams(), t.readParams())
            assert.strictEqual(t.readParams().database, 'XChain_BTC_Regtest_Indexer')
        })

        it('reports the mirror as not in play, so waits are a no-op', () => {
            assert.strictEqual(freshTopology().seedsThroughMirror(), false)
        })

        it('clears exactly one database rather than opening a second connection', () => {
            assert.strictEqual(freshTopology().clearTargets().length, 1)
        })
    })

    // Topology 2: HUB_DB_HOST is injected for the federation suites but no
    // database is named. The indexer requires BOTH before it opens a hubDb, so
    // this must still resolve to the local DB. Keying on the host alone was a
    // real past defect: it seeded XChain_Hub while the indexer matched against
    // its own table, giving a deterministic 'no matching price snapshot'.
    describe('HUB_DB_HOST without HUB_DB_NAME', () => {
        it('still reads locally, matching the indexer\'s own both-or-nothing condition', () => {
            process.env.HUB_DB_HOST = 'mariadb'
            const t = freshTopology()
            assert.strictEqual(t.readParams().database, 'XChain_BTC_Regtest_Indexer')
            assert.strictEqual(t.seedsThroughMirror(), false)
        })
    })

    // Topology 3: the indexer points hubDb straight at the hub's MariaDB and no
    // sync runs. Seed and read are one database, so nothing has to replicate.
    describe('shared-DB shortcut (HUB_DB_* set, no hub source named)', () => {
        beforeEach(() => {
            process.env.HUB_DB_HOST = 'mariadb'
            process.env.HUB_DB_NAME = 'XChain_Hub'
            process.env.HUB_DB_USER = 'xchain_hub'
        })

        it('reads from the hub DB, not the indexer\'s own', () => {
            assert.strictEqual(freshTopology().readParams().database, 'XChain_Hub')
        })

        it('seeds into the same database it reads, so no wait is required', () => {
            const t = freshTopology()
            assert.strictEqual(t.seedParams().database, 'XChain_Hub')
            assert.strictEqual(t.seedsThroughMirror(), false)
        })
    })

    // Topology 4: what  exists to enable. hub_db_sync owns the mirror, so
    // the fixture seeds the hub's authoritative database and waits for the row
    // to arrive in the mirror.
    describe('true mirror (hub source named alongside the mirror)', () => {
        beforeEach(() => {
            process.env.HUB_DB_HOST = 'mariadb'
            process.env.HUB_DB_NAME = 'XChain_Hub_Mirror'
            process.env.HUB_DB_USER = 'xchain_hub'
            process.env.HUB_SOURCE_DB_NAME = 'XChain_Hub'
        })

        it('seeds the hub and reads the mirror, which are different databases', () => {
            const t = freshTopology()
            assert.strictEqual(t.seedParams().database, 'XChain_Hub')
            assert.strictEqual(t.readParams().database, 'XChain_Hub_Mirror')
        })

        it('reports the mirror as in play so seeding waits for replication', () => {
            assert.strictEqual(freshTopology().seedsThroughMirror(), true)
        })

        // The regression that motivated this file. waitForMirror polls
        // readParams(); if that resolved to the indexer's own DB the wait would
        // watch a table hub_db_sync never writes to and time out on every seed.
        it('never resolves the read target to the indexer\'s own database', () => {
            const t = freshTopology()
            assert.notStrictEqual(t.readParams().database, LOCAL.dbName)
            assert.strictEqual(t.sameTarget(t.readParams(), t.localParams()), false)
        })

        it('clears both databases, since a plain DELETE upstream is not replicated', () => {
            const names = freshTopology().clearTargets().map(p => p.database).sort()
            assert.deepStrictEqual(names, ['XChain_Hub', 'XChain_Hub_Mirror'])
        })

        it('inherits host, port and credentials from the hub DB connection', () => {
            process.env.HUB_DB_PORT = '3307'
            process.env.HUB_DB_PASS = 'secret'
            const seed = freshTopology().seedParams()
            assert.strictEqual(seed.host, 'mariadb')
            assert.strictEqual(seed.port, 3307)
            assert.strictEqual(seed.user, 'xchain_hub')
            assert.strictEqual(seed.password, 'secret')
        })

        it('lets the hub live on its own host when explicitly overridden', () => {
            process.env.HUB_SOURCE_DB_HOST = 'hub-box'
            process.env.HUB_SOURCE_DB_PORT = '3399'
            const seed = freshTopology().seedParams()
            assert.strictEqual(seed.host, 'hub-box')
            assert.strictEqual(seed.port, 3399)
        })
    })

    // A mirror DB whose name happens to equal the hub's is the shared-DB
    // shortcut spelled a longer way, and must not claim a replication leg that
    // is not there, or every seed would wait 30s for a row already present.
    describe('hub source naming the same database as the mirror', () => {
        it('collapses to no mirror in play', () => {
            process.env.HUB_DB_HOST = 'mariadb'
            process.env.HUB_DB_NAME = 'XChain_Hub'
            process.env.HUB_SOURCE_DB_NAME = 'XChain_Hub'
            const t = freshTopology()
            assert.strictEqual(t.seedsThroughMirror(), false)
            assert.strictEqual(t.clearTargets().length, 1)
        })
    })

    describe('assertCoherent', () => {
        it('accepts every supported topology', () => {
            const t = freshTopology()
            assert.doesNotThrow(() => t.assertCoherent())
            process.env.HUB_DB_HOST = 'mariadb'
            process.env.HUB_DB_NAME = 'XChain_Hub_Mirror'
            process.env.HUB_SOURCE_DB_NAME = 'XChain_Hub'
            assert.doesNotThrow(() => freshTopology().assertCoherent())
        })

        // Seeding upstream while the indexer reads its own DB can only ever hang:
        // nothing replicates into the database being watched. Failing at the
        // first seed with the reason beats 30s of silence per case.
        it('rejects a hub source with no mirror for it to arrive in', () => {
            process.env.HUB_SOURCE_DB_NAME = 'XChain_Hub'
            const t = freshTopology()
            assert.throws(() => t.assertCoherent(), /HUB_SOURCE_DB_NAME is set but HUB_DB_HOST\/HUB_DB_NAME are not/)
        })
    })

    describe('no indexer database configured', () => {
        it('reports nothing to clear and no mirror rather than throwing', () => {
            global.indexerDatabase = null
            const t = freshTopology()
            assert.strictEqual(t.readParams(), null)
            assert.strictEqual(t.seedsThroughMirror(), false)
            assert.deepStrictEqual(t.clearTargets(), [])
        })
    })
})
