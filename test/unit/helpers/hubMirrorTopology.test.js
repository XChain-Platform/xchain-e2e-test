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

// The FIAT price fixtures can be pointed at three different databases,
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

describe('hubMirrorTopology', () => {
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

    // Topology 1: a regtest stack as it stands today. No hub DB is
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

    // Topology 4: what this exists to enable. hub_db_sync owns the mirror, so
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

    // Topology 5, and the reason discovery exists at all: the env above is this
    // process's MODEL of the indexer's config, and the indexer is a different process
    // with a different env. Once a venue sets HUB_DB_NAME on the indexer alone (the
    // cross-chain settle recipe does), the model is wrong in a way nothing observes:
    // fixtures seed one database, every price lookup reads the other, both look
    // healthy, and every priced action rejects `no current oracle price`. It made the
    // settle drills and the attestation suites mutually exclusive on one venue.
    describe('discoverReadParams (ask the indexer instead of modelling it)', () => {
        let savedConnector
        beforeEach(() => { savedConnector = global.indexerConnector; delete global.indexerConnector })
        afterEach(() => {
            if (savedConnector === undefined) delete global.indexerConnector
            else global.indexerConnector = savedConnector
        })

        function connectorSaying(priceSource, opts){
            const o = opts || {}
            return { call: async (method) => {
                if (method !== 'feeschedule') throw new Error('unexpected method ' + method)
                if (o.throws) throw new Error('indexer unreachable')
                if (o.error) return { error: o.error }
                return { coin: 'BTC', prices: { available: true }, priceSource: priceSource }
            } }
        }

        // Discovery probes a candidate before pinning it. These cases are about the
        // resolution, not the network, so the probe is stubbed; `probes` records the
        // order candidates were offered in.
        function probeAccepting(predicate, probes){
            return async (params) => {
                if (probes) probes.push(params)
                return predicate ? !!predicate(params) : true
            }
        }
        const ANY = { probe: probeAccepting(null) }

        it('pins the hub database the indexer names, even with HUB_DB_NAME unset', async () => {
            process.env.HUB_DB_HOST = 'mariadb'
            process.env.HUB_DB_USER = 'xchain_hub'
            process.env.HUB_DB_PASS = 'secret'
            const t = freshTopology()
            // Before discovery the both-or-nothing env model resolves to the local DB,
            // which is precisely the wrong answer on this venue.
            assert.strictEqual(t.readParams().database, LOCAL.dbName)

            const pinned = await t.discoverReadParams(connectorSaying({ hubDb: true, database: 'XChain_Hub' }), ANY)
            assert.strictEqual(pinned.database, 'XChain_Hub')
            assert.strictEqual(t.readParams().database, 'XChain_Hub')
            assert.strictEqual(t.discoveredReadParams().database, 'XChain_Hub')
            // Coordinates stay this process's business: the name is the only thing the
            // indexer is authoritative about, since its host lives in another namespace.
            assert.strictEqual(t.readParams().host, 'mariadb')
            assert.strictEqual(t.readParams().user, 'xchain_hub')
            assert.strictEqual(t.readParams().password, 'secret')
        })

        // The mirror-image bug, and the one that bites when a venue is REVERTED: the
        // runner still exports a hub DB the indexer no longer reads.
        it('pins the local database when the indexer says it reads its own, overriding the env', async () => {
            process.env.HUB_DB_HOST = 'mariadb'
            process.env.HUB_DB_NAME = 'XChain_Hub'
            const t = freshTopology()
            assert.strictEqual(t.readParams().database, 'XChain_Hub', 'env model before discovery')

            await t.discoverReadParams(connectorSaying({ hubDb: false, database: LOCAL.dbName }), ANY)
            assert.strictEqual(t.readParams().database, LOCAL.dbName)
            assert.strictEqual(t.seedsThroughMirror(), false)
        })

        it('falls back to HUB_DB_NAME when the indexer withholds the name (mainnet)', async () => {
            process.env.HUB_DB_HOST = 'mariadb'
            process.env.HUB_DB_NAME = 'XChain_Hub'
            const t = freshTopology()
            const pinned = await t.discoverReadParams(connectorSaying({ hubDb: true, database: null }), ANY)
            assert.strictEqual(pinned.database, 'XChain_Hub')
        })

        it('pins nothing when the indexer names no database and the env names none either', async () => {
            const t = freshTopology()
            assert.strictEqual(await t.discoverReadParams(connectorSaying({ hubDb: true, database: null }), ANY), null)
            assert.strictEqual(t.discoveredReadParams(), null)
            assert.strictEqual(t.readParams().database, LOCAL.dbName, 'env model left in force')
        })

        // A venue whose indexer predates the disclosure must behave exactly as it did.
        it('leaves the env model in force when the indexer does not disclose priceSource', async () => {
            process.env.HUB_DB_HOST = 'mariadb'
            process.env.HUB_DB_NAME = 'XChain_Hub'
            const t = freshTopology()
            assert.strictEqual(await t.discoverReadParams(connectorSaying(undefined), ANY), null)
            assert.strictEqual(t.readParams().database, 'XChain_Hub')
        })

        it('never throws when the indexer is unreachable or answers an error', async () => {
            const t = freshTopology()
            assert.strictEqual(await t.discoverReadParams(connectorSaying(null, { throws: true }), ANY), null)
            assert.strictEqual(await t.discoverReadParams(connectorSaying(null, { error: 'indexer not ready' }), ANY), null)
            assert.strictEqual(await t.discoverReadParams(null, ANY), null)
            assert.strictEqual(t.readParams().database, LOCAL.dbName)
        })

        // clearPair/clearTargets follow the pinned answer too, or a stale row survives
        // in the database the indexer is actually reading.
        it('routes clearTargets at the discovered database', async () => {
            const t = freshTopology()
            process.env.HUB_DB_HOST = 'mariadb'
            await t.discoverReadParams(connectorSaying({ hubDb: true, database: 'XChain_Hub' }), ANY)
            assert.deepStrictEqual(t.clearTargets().map(p => p.database), ['XChain_Hub'])
        })

        // The upstream-seed guard has to key on the RESOLVED read target: with a hub
        // source named and the indexer reading its own DB, every seed would wait out its
        // full timeout for a row nothing will ever carry down.
        it('makes assertCoherent reject a hub source once the indexer reports a local read', async () => {
            process.env.HUB_DB_HOST = 'mariadb'
            process.env.HUB_DB_NAME = 'XChain_Hub_Mirror'
            process.env.HUB_SOURCE_DB_NAME = 'XChain_Hub'
            const t = freshTopology()
            assert.doesNotThrow(() => t.assertCoherent(), 'coherent while the env model holds')
            await t.discoverReadParams(connectorSaying({ hubDb: false, database: LOCAL.dbName }), ANY)
            assert.throws(() => t.assertCoherent(), /HUB_SOURCE_DB_NAME is set but/)
        })

        // The coordinates are ours because the indexer's are not dialable from here:
        // HUB_DB_HOST commonly holds a compose service name, and a suite reaching the
        // stack over a published port cannot resolve it. Trying the explicit env first
        // keeps a genuinely separate relay DB reachable; falling back to the indexer's
        // own host keeps the ordinary stack working when that name is fiction.
        it('offers the env coordinates first, then the indexer host, then its credentials', async () => {
            process.env.HUB_DB_HOST = 'relay-box'
            process.env.HUB_DB_PORT = '13341'
            process.env.HUB_DB_USER = 'xchain_hub'
            process.env.HUB_DB_PASS = 'hubpass'
            const t = freshTopology()
            const probes = []
            const pinned = await t.discoverReadParams(
                connectorSaying({ hubDb: true, database: 'XChain_Hub' }),
                { probe: probeAccepting(p => p.host === LOCAL.host && p.user === LOCAL.user, probes) })

            assert.deepStrictEqual(probes.map(p => [p.host, p.port, p.user]), [
                ['relay-box', 13341, 'xchain_hub'],
                ['mariadb',   3306,  'xchain_hub'],
                ['mariadb',   3306,  'idx']
            ])
            assert.strictEqual(pinned.database, 'XChain_Hub')
            assert.strictEqual(pinned.user, 'idx', 'pins the candidate that actually answered')
        })

        it('collapses to a single candidate on the ordinary one-MariaDB stack', async () => {
            const t = freshTopology()
            const probes = []
            await t.discoverReadParams(connectorSaying({ hubDb: true, database: 'XChain_Hub' }),
                { probe: probeAccepting(null, probes) })
            assert.strictEqual(probes.length, 1)
        })

        // Pinning nothing here would send the seed back to the indexer's own database,
        // which is the silent wrong answer this whole path exists to remove. Better a
        // loud failure that names the database the indexer is really reading.
        it('pins the hub database anyway when no candidate can reach it', async () => {
            process.env.HUB_DB_HOST = 'relay-box'
            const t = freshTopology()
            const pinned = await t.discoverReadParams(
                connectorSaying({ hubDb: true, database: 'XChain_Hub' }),
                { probe: probeAccepting(() => false) })
            assert.strictEqual(pinned.database, 'XChain_Hub')
            assert.strictEqual(pinned.host, 'relay-box')
            assert.strictEqual(t.readParams().database, 'XChain_Hub')
        })

        it('treats a probe that throws as unreachable rather than propagating it', async () => {
            const t = freshTopology()
            const pinned = await t.discoverReadParams(
                connectorSaying({ hubDb: true, database: 'XChain_Hub' }),
                { probe: async () => { throw new Error('ECONNREFUSED') } })
            assert.strictEqual(pinned.database, 'XChain_Hub')
        })

        it('resetDiscovery restores the env model', async () => {
            process.env.HUB_DB_HOST = 'mariadb'
            const t = freshTopology()
            await t.discoverReadParams(connectorSaying({ hubDb: true, database: 'XChain_Hub' }), ANY)
            assert.strictEqual(t.readParams().database, 'XChain_Hub')
            t.resetDiscovery()
            assert.strictEqual(t.readParams().database, LOCAL.dbName)
        })
    })
})
