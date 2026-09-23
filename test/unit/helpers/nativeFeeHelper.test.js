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

// discoverFeeMode feeschedule-readiness retry: first-file DOGE runs
// after a fresh reset used to fail beforeAll because the single-shot
// feeschedule probe hit the indexer's startup window ('indexer not ready').

const assert = require('assert')

const HELPER_PATH = require.resolve('../../helpers/nativeFeeHelper')

// Fresh module instance per test: the helper caches _feeMode after first
// resolution, so retry behavior is only observable on a clean require.
function freshHelper(){
    delete require.cache[HELPER_PATH]
    return require(HELPER_PATH)
}

describe('nativeFeeHelper.discoverFeeMode', () => {
    const savedEnv = {}
    const ENV_KEYS = ['NATIVE_FEE_DISCOVERY_TIMEOUT_MS', 'NATIVE_FEE_DISCOVERY_POLL_MS', 'FEE_DESTINATION']
    let savedCoin, savedNetwork, savedConnector

    beforeEach(() => {
        for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
        savedCoin = global.COIN_CODE
        savedNetwork = global.NETWORK
        savedConnector = global.indexerConnector
        global.NETWORK = 'regtest'
        // Fast retries so the timeout tests stay sub-second.
        process.env.NATIVE_FEE_DISCOVERY_TIMEOUT_MS = '300'
        process.env.NATIVE_FEE_DISCOVERY_POLL_MS = '20'
    })

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k]
            else process.env[k] = savedEnv[k]
        }
        global.COIN_CODE = savedCoin
        global.NETWORK = savedNetwork
        global.indexerConnector = savedConnector
        delete require.cache[HELPER_PATH]
    })

    it('retries "indexer not ready" on DOGE until feeschedule is populated', async () => {
        global.COIN_CODE = 'DOGE'
        let calls = 0
        global.indexerConnector = { call: async (method) => {
            assert.strictEqual(method, 'feeschedule')
            calls++
            if (calls < 3) return { error: 'indexer not ready' }
            return { nativeFeeEnabled: true, feeDestination: 'DFeeDest111' }
        }}
        const mode = await freshHelper().discoverFeeMode()
        assert.strictEqual(calls, 3)
        assert.deepStrictEqual(mode, { enabled: true, destination: 'DFeeDest111' })
    })

    it('retries connection failures (thrown) on a fee chain', async () => {
        global.COIN_CODE = 'LTC'
        let calls = 0
        global.indexerConnector = { call: async () => {
            calls++
            if (calls < 2) throw new Error('ECONNREFUSED')
            return { nativeFeeEnabled: true, feeDestination: 'LFeeDest111' }
        }}
        const mode = await freshHelper().discoverFeeMode()
        assert.strictEqual(calls, 2)
        assert.deepStrictEqual(mode, { enabled: true, destination: 'LFeeDest111' })
    })

    it('throws after the readiness budget when feeschedule never becomes ready', async () => {
        global.COIN_CODE = 'DOGE'
        let calls = 0
        global.indexerConnector = { call: async () => { calls++; return { error: 'indexer not ready' } } }
        await assert.rejects(
            () => freshHelper().discoverFeeMode(),
            (err) => /native-fee discovery failed on DOGE/.test(err.message) &&
                     /indexer not ready/.test(err.message)
        )
        assert.ok(calls > 1, 'expected multiple attempts, got ' + calls)
    })

    it('does not retry on gas-mode BTC (single probe, falls back to disabled)', async () => {
        global.COIN_CODE = 'BTC'
        let calls = 0
        global.indexerConnector = { call: async () => { calls++; return { error: 'indexer not ready' } } }
        const mode = await freshHelper().discoverFeeMode()
        assert.strictEqual(calls, 1)
        assert.deepStrictEqual(mode, { enabled: false, destination: null })
    })

    it('env FEE_DESTINATION overrides without touching the indexer', async () => {
        global.COIN_CODE = 'DOGE'
        process.env.FEE_DESTINATION = 'DEnvDest111'
        let calls = 0
        global.indexerConnector = { call: async () => { calls++; return {} } }
        const mode = await freshHelper().discoverFeeMode()
        assert.strictEqual(calls, 0)
        assert.deepStrictEqual(mode, { enabled: true, destination: 'DEnvDest111' })
    })

    it('caches the discovered mode (second call makes no further RPC)', async () => {
        global.COIN_CODE = 'DOGE'
        let calls = 0
        global.indexerConnector = { call: async () => {
            calls++
            return { nativeFeeEnabled: true, feeDestination: 'DFeeDest111' }
        }}
        const helper = freshHelper()
        await helper.discoverFeeMode()
        await helper.discoverFeeMode()
        assert.strictEqual(calls, 1)
    })
})

// seedGlobalPrices anchoring. A seeded snapshot at S is usable by a block at
// time B only inside S <= B <= S + 1800: the upper bound is the indexer's
// staleness guard, the LOWER bound is the H-3 selection gate on LTC/DOGE
// (getLatestPrice's `block_timestamp <= ?`). The old single max(tip, now) anchor
// honoured only the upper bound, so a chain whose clock trails wall time - which
// is how every clock drill leaves it - had its prices silently invisible and
// every fee-bearing action rejected `no current oracle price`.
describe('nativeFeeHelper.seedGlobalPrices anchoring', () => {
    const SNAPSHOT_PATH = require.resolve('../../helpers/priceSnapshotHelper')
    let savedSnapshotModule, savedCoin, savedIndexerDb
    let seeded, cleared, chainTime

    // Stub priceSnapshotHelper through require.cache so the helper's own
    // module-level require picks it up on the fresh require below.
    function stubSnapshots(){
        seeded = []
        cleared = []
        require.cache[SNAPSHOT_PATH] = { id: SNAPSHOT_PATH, filename: SNAPSHOT_PATH, loaded: true, exports: {
            isAvailable: async () => true,
            latestBlockTime: async () => chainTime,
            clearPair: async (pair) => { cleared.push(pair) },
            seedSnapshot: async (row) => { seeded.push(row) }
        }}
    }

    beforeEach(() => {
        savedSnapshotModule = require.cache[SNAPSHOT_PATH]
        savedCoin = global.COIN_CODE
        savedIndexerDb = global.indexerDatabase
        global.COIN_CODE = 'LTC'
        stubSnapshots()
    })

    afterEach(() => {
        if (savedSnapshotModule) require.cache[SNAPSHOT_PATH] = savedSnapshotModule
        else delete require.cache[SNAPSHOT_PATH]
        global.COIN_CODE = savedCoin
        global.indexerDatabase = savedIndexerDb
        delete require.cache[HELPER_PATH]
    })

    function anchorsFor(pair){
        return seeded.filter(r => r.coinPair === pair).map(r => r.blockTimestamp)
    }

    it('seeds BOTH the chain-clock and wall-clock anchors when the chain trails', async () => {
        const wall = Math.floor(Date.now() / 1000)
        chainTime = wall - 2547                    // the LTC stack as found: pinned in the past
        await freshHelper().seedGlobalPrices(true)
        for (const pair of ['XCHAIN/USD', 'LTC/USD']) {
            const anchors = anchorsFor(pair)
            assert.strictEqual(anchors.length, 2, pair + ' needs a chain anchor AND a wall anchor')
            assert.strictEqual(anchors[0], chainTime, pair + ' must carry a row the frozen chain can see')
            assert(anchors[1] >= wall, pair + ' must also carry a row that stays fresh once the clock is released')
        }
        // The wall-clock row must WIN where both are visible, and getLatestPrice
        // orders by round_number, so the later anchor needs the higher round.
        const rows = seeded.filter(r => r.coinPair === 'LTC/USD')
        assert(rows[1].roundNumber > rows[0].roundNumber, 'the fresher anchor must carry the higher round')
    })

    it('seeds ONE chain-anchored row when the chain leads wall time (post-jump)', async () => {
        chainTime = Math.floor(Date.now() / 1000) + 3600
        await freshHelper().seedGlobalPrices(true)
        for (const pair of ['XCHAIN/USD', 'LTC/USD'])
            assert.deepStrictEqual(anchorsFor(pair), [chainTime], pair + ' must anchor on the chain, not the wall clock')
    })

    it('re-seeds inside the wall-clock throttle once the CHAIN clock jumps', async () => {
        chainTime = Math.floor(Date.now() / 1000) + 60
        const helper = freshHelper()
        await helper.seedGlobalPrices(true)
        const afterFirst = seeded.length

        // Same wall-clock instant, so the throttle would suppress this on its own.
        await helper.seedGlobalPrices()
        assert.strictEqual(seeded.length, afterFirst, 'an unmoved chain clock must not re-seed')

        // A drill jump of an hour ages the snapshot straight out of the 1800s window.
        chainTime += 3600
        await helper.seedGlobalPrices()
        assert(seeded.length > afterFirst, 'a jumped chain clock must re-seed despite the throttle')
    })

    it('re-seeds when the chain clock moves BACKWARDS, however slightly', async () => {
        chainTime = Math.floor(Date.now() / 1000) + 60
        const helper = freshHelper()
        await helper.seedGlobalPrices(true)
        const afterFirst = seeded.length
        // One second below the anchor is already fatal: the H-3 gate excludes a
        // snapshot the block cannot see, so this is not a small version of drift.
        chainTime -= 1
        await helper.seedGlobalPrices()
        assert(seeded.length > afterFirst, 'a rewound chain clock must re-seed')
    })
})

// A seed the indexer cannot see is worse than no seed: every priced action rejects
// `no current oracle price` while the seed log says the prices are in place, and both
// databases involved look healthy. That is exactly how a venue setting HUB_DB_NAME on
// the indexer alone presented, and it is why the bootstrap seed checks itself.
describe('nativeFeeHelper.warnIfSeedInvisible', () => {
    let savedConnector, savedLog, lines

    beforeEach(() => {
        savedConnector = global.indexerConnector
        lines = []
        savedLog = console.log
        console.log = (...a) => lines.push(a.join(' '))
    })

    afterEach(() => {
        console.log = savedLog
        if (savedConnector === undefined) delete global.indexerConnector
        else global.indexerConnector = savedConnector
        delete require.cache[HELPER_PATH]
    })

    function connector(sched){
        return { call: async () => sched }
    }

    it('names both databases when the indexer still has no usable price', async () => {
        global.indexerConnector = connector({
            prices: { available: false, error: 'no current oracle price for BTC/USD' },
            priceSource: { hubDb: true, database: 'XChain_Hub' }
        })
        await freshHelper().warnIfSeedInvisible({ database: 'XChain_BTC_Regtest_Indexer' })
        const warn = lines.find(l => /WARN the indexer still reports no usable price/.test(l))
        assert(warn, 'expected a warning, got: ' + JSON.stringify(lines))
        assert(/Seeded into: XChain_BTC_Regtest_Indexer/.test(warn), warn)
        assert(/Indexer reads: hub database XChain_Hub/.test(warn), warn)
    })

    it('says nothing when the indexer can price against the seed', async () => {
        global.indexerConnector = connector({
            prices: { available: true },
            priceSource: { hubDb: false, database: 'XChain_BTC_Regtest_Indexer' }
        })
        await freshHelper().warnIfSeedInvisible({ database: 'XChain_BTC_Regtest_Indexer' })
        assert.deepStrictEqual(lines, [])
    })

    // An older indexer, an unreachable one, or one that is simply not ready must not
    // turn the bootstrap into a false alarm or an exception.
    it('stays silent and never throws when the indexer cannot answer', async () => {
        const helper = freshHelper()
        global.indexerConnector = { call: async () => { throw new Error('ECONNREFUSED') } }
        await helper.warnIfSeedInvisible({ database: 'X' })
        global.indexerConnector = connector({ error: 'indexer not ready' })
        await helper.warnIfSeedInvisible({ database: 'X' })
        delete global.indexerConnector
        await helper.warnIfSeedInvisible({ database: 'X' })
        assert.deepStrictEqual(lines, [])
    })

    it('reports an undisclosed price source distinctly from a named one', async () => {
        global.indexerConnector = connector({ prices: { available: false, error: 'stale' } })
        await freshHelper().warnIfSeedInvisible(null)
        const warn = lines.find(l => /WARN the indexer still reports no usable price/.test(l))
        assert(warn, 'expected a warning, got: ' + JSON.stringify(lines))
        assert(/Indexer reads: undisclosed/.test(warn), warn)
        assert(/Seeded into: unknown/.test(warn), warn)
    })

    // Once the seed goes upstream of the mirror, the two databases differ BY DESIGN, so
    // the mismatch advice is a false accusation that sends an operator to "fix" a correct
    // configuration. The unavailability itself is still real and still reported: the
    // direct write went in too, so a missing price is the mirror leg, not the seed.
    it('drops the database-mismatch advice when the seed went through the hub', async () => {
        global.indexerConnector = connector({
            prices: { available: false, error: 'no current oracle price for BTC/USD' },
            priceSource: { hubDb: true, database: 'XChain_BTC_Regtest_Indexer' }
        })
        await freshHelper().warnIfSeedInvisible(
            { database: 'XChain_BTC_Regtest_Indexer' },
            { direct: { database: 'XChain_BTC_Regtest_Indexer' }, hub: { database: 'XChain_Hub' }, hubError: null })
        const warn = lines.find(l => /WARN the indexer still reports no usable price/.test(l))
        assert(warn, 'expected a warning, got: ' + JSON.stringify(lines))
        assert(/Seeded into: hub database XChain_Hub \(upstream\) and XChain_BTC_Regtest_Indexer/.test(warn), warn)
        assert(!/pointed at different\s+databases/.test(warn),
            'the mismatch advice must not be repeated where the databases differ by design: ' + warn)
        assert(/differ by design/.test(warn), warn)
        assert(/hub_db_sync/.test(warn), warn)
    })
})

// Replay-safety (spec D45 / row 29c). A seed written only where the indexer READS does
// not survive that indexer: price_snapshots is a hub_db_sync FULL_REPAGE table, so a
// `reset` rebuilds it from the hub, and _reconcileForeignPriceRounds deletes finalized
// rows the hub never served. Seeding the hub's own table is what makes a drive's
// native-fee blocks reproducible on replay.
describe('nativeFeeHelper.seedGlobalPrices hub seeding', () => {
    const SNAPSHOT_PATH = require.resolve('../../helpers/priceSnapshotHelper')
    const TOPOLOGY_PATH = require.resolve('../../helpers/hubMirrorTopology')
    const MARIADB_PATH  = require.resolve('mariadb')
    const ENV_KEYS = ['HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS',
        'HUB_SOURCE_DB_HOST', 'HUB_SOURCE_DB_PORT', 'HUB_SOURCE_DB_NAME',
        'HUB_SOURCE_DB_USER', 'HUB_SOURCE_DB_PASS']

    const topology = require(TOPOLOGY_PATH)
    const savedEnv = {}
    let savedSnapshotModule, savedMariadbModule, savedCoin, savedIndexerDb, savedLog
    let events, hubConns, seeded, cleared, chainTime, lines

    // One ordered log for both write paths: the hub write must land BEFORE the direct
    // one, so a mirror re-page between them cannot purge the direct copy as a round the
    // hub does not hold.
    function stubSnapshots(){
        seeded = []
        cleared = []
        require.cache[SNAPSHOT_PATH] = { id: SNAPSHOT_PATH, filename: SNAPSHOT_PATH, loaded: true, exports: {
            isAvailable: async () => true,
            latestBlockTime: async () => chainTime,
            seedTarget: () => ({ database: 'XChain_BTC_Regtest_Indexer' }),
            clearPair: async (pair) => { cleared.push(pair); events.push('clearPair:' + pair) },
            seedSnapshot: async (row) => { seeded.push(row); events.push('seedSnapshot:' + row.roundNumber) }
        }}
    }

    // Fake driver. `mode` is 'ok' or 'refuse' (a hub this process cannot reach).
    function stubMariadb(mode){
        hubConns = []
        require.cache[MARIADB_PATH] = { id: MARIADB_PATH, filename: MARIADB_PATH, loaded: true, exports: {
            createConnection: async (params) => {
                if (mode === 'refuse') throw new Error('connection refused by the fake driver')
                const rec = { params, queries: [], ended: false }
                hubConns.push(rec)
                events.push('hubConnect:' + params.database)
                return {
                    query: async (sql, args) => {
                        rec.queries.push({ sql, args })
                        events.push('hubQuery:' + (args && args[0]))
                        return { affectedRows: 1 }
                    },
                    end: async () => { rec.ended = true }
                }
            }
        }}
    }

    beforeEach(() => {
        for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
        savedSnapshotModule = require.cache[SNAPSHOT_PATH]
        savedMariadbModule  = require.cache[MARIADB_PATH]
        savedCoin = global.COIN_CODE
        savedIndexerDb = global.indexerDatabase
        global.COIN_CODE = 'LTC'
        // The chain trails the wall clock, which is the regime that writes all four rows.
        chainTime = Math.floor(Date.now() / 1000) - 2547
        events = []
        lines = []
        savedLog = console.log
        console.log = (...a) => lines.push(a.join(' '))
        topology.resetDiscovery()
        stubSnapshots()
        stubMariadb('ok')
    })

    afterEach(() => {
        console.log = savedLog
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k]
            else process.env[k] = savedEnv[k]
        }
        if (savedSnapshotModule) require.cache[SNAPSHOT_PATH] = savedSnapshotModule
        else delete require.cache[SNAPSHOT_PATH]
        if (savedMariadbModule) require.cache[MARIADB_PATH] = savedMariadbModule
        else delete require.cache[MARIADB_PATH]
        global.COIN_CODE = savedCoin
        global.indexerDatabase = savedIndexerDb
        topology.resetDiscovery()
        delete require.cache[HELPER_PATH]
    })

    // HUB_SOURCE_DB_NAME is the operator saying "hub_db_sync is carrying these tables,
    // so seed upstream of it" (hubMirrorTopology's env contract).
    function mirroredVenue(){
        process.env.HUB_DB_HOST = 'venue-db.invalid'
        process.env.HUB_DB_NAME = 'XChain_BTC_Regtest_Indexer'
        process.env.HUB_SOURCE_DB_NAME = 'XChain_Hub'
    }

    it('writes the seed rows into the hub database the mirror bootstraps from', async () => {
        mirroredVenue()
        const helper = freshHelper()
        assert.strictEqual(helper.hubSeedTarget().database, 'XChain_Hub')
        await helper.seedGlobalPrices(true)

        assert.strictEqual(hubConns.length, 1, 'expected exactly one hub connection')
        const conn = hubConns[0]
        assert.strictEqual(conn.params.database, 'XChain_Hub')
        assert.strictEqual(conn.params.host, 'venue-db.invalid')
        assert.strictEqual(conn.ended, true, 'the hub connection must be closed')

        // Both pairs at both anchors, oldest anchor first so the fresher row carries the
        // higher round, exactly as the direct path orders them.
        assert.deepStrictEqual(conn.queries.map(q => q.args[0]),
            [888100001, 888100002, 888100011, 888100012])
        assert.deepStrictEqual(conn.queries.map(q => q.args[1]),
            ['XCHAIN/USD', 'LTC/USD', 'XCHAIN/USD', 'LTC/USD'])
        assert.deepStrictEqual(conn.queries.map(q => q.args[3]),
            [chainTime, chainTime, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)])
    })

    it('upserts finalized rows and never deletes on the hub', async () => {
        mirroredVenue()
        await freshHelper().seedGlobalPrices(true)
        for (const q of hubConns[0].queries) {
            assert(/INSERT INTO price_snapshots/.test(q.sql), q.sql)
            assert(/ON DUPLICATE KEY UPDATE/.test(q.sql), q.sql)
            assert(/'finalized'/.test(q.sql), q.sql)
            // The hub's table is the federation's authoritative price history; clearing a
            // pair there would destroy real validator rounds.
            assert(!/DELETE/i.test(q.sql), 'the hub path must never delete: ' + q.sql)
        }
    })

    it('still writes the copy the running indexer reads, hub first', async () => {
        mirroredVenue()
        await freshHelper().seedGlobalPrices(true)
        // The mirror carries no out-of-band hub row live (HubDbBroadcaster only fires for
        // the hub's own writers, and price_snapshots re-pages on reconnect), so the direct
        // write is what prices THIS run.
        assert.deepStrictEqual(cleared, ['XCHAIN/USD', 'LTC/USD'])
        assert.strictEqual(seeded.length, 4)
        const firstDirect = events.findIndex(e => e.startsWith('clearPair:'))
        const lastHub     = events.map(e => e.startsWith('hubQuery:')).lastIndexOf(true)
        assert(lastHub >= 0 && lastHub < firstDirect,
            'every hub write must precede the direct write: ' + JSON.stringify(events))
    })

    it('falls back to the direct write alone when no hub database is named', async () => {
        // No HUB_SOURCE_DB_NAME: seedParams collapses onto the read target and there is
        // no upstream to seed, which is the pre-D45 behaviour unchanged.
        process.env.HUB_DB_HOST = 'venue-db.invalid'
        process.env.HUB_DB_NAME = 'XChain_BTC_Regtest_Indexer'
        const helper = freshHelper()
        assert.strictEqual(helper.hubSeedTarget(), null)
        await helper.seedGlobalPrices(true)
        assert.strictEqual(hubConns.length, 0, 'no hub connection may be opened')
        assert.deepStrictEqual(cleared, ['XCHAIN/USD', 'LTC/USD'])
        assert.strictEqual(seeded.length, 4)
        assert.strictEqual(helper.lastSeedReport().hub, null)
    })

    it('survives an unreachable hub: warns, seeds directly, and says the replay is not covered', async () => {
        mirroredVenue()
        stubMariadb('refuse')
        const helper = freshHelper()
        await helper.seedGlobalPrices(true)
        assert.strictEqual(seeded.length, 4, 'the direct seed must still carry the run')
        const report = helper.lastSeedReport()
        assert.strictEqual(report.hub, null)
        assert(/connection refused/.test(report.hubError), report.hubError)
        const warn = lines.find(l => /could not seed the hub database XChain_Hub/.test(l))
        assert(warn, 'expected a hub-seed warning, got: ' + JSON.stringify(lines))
        assert(/reset will replay these blocks with no oracle price/.test(warn), warn)
    })

    it('records the hub target so a run can say its prices are replay-safe', async () => {
        mirroredVenue()
        const helper = freshHelper()
        await helper.seedGlobalPrices(true)
        const report = helper.lastSeedReport()
        assert.strictEqual(report.hub.database, 'XChain_Hub')
        assert.strictEqual(report.direct.database, 'XChain_BTC_Regtest_Indexer')
        assert.strictEqual(report.hubError, null)
        const log = lines.find(l => /seeded oracle prices/.test(l))
        assert(/hub_db=XChain_Hub \(replay-safe\)/.test(log), log)
    })
})

// Native fee sizing at send time (nightly run 35899520268). The flat output was the
// whole fee model, and it held only while the indexer priced off the seed: a suite
// re-pricing a pair for its own case, or a mirror reconcile that deleted the seed and
// left the hub's live rounds in force, both raised the expected fee past it, and every
// LTC/DOGE shard went red on `insufficient native coin fee (paid: 0.00050000, ...)`.
describe('nativeFeeHelper.nativeFeeSats', () => {
    const SNAPSHOT_PATH = require.resolve('../../helpers/priceSnapshotHelper')
    let savedSnapshotModule, savedCoin, savedNetwork, savedConnector, savedLog
    let calls, seeded, schedules, quote, chainTime

    const SEED       = { xchainUsd: '2.00000000', coinUsd: '100000.00000000', oracleRound: 888100012 }
    const REPRICED   = { xchainUsd: '2.00000000', coinUsd: '1000.00000000',   oracleRound: 997710002 }
    const LIVE_HUB   = { xchainUsd: '2.00000000', coinUsd: '0.11414000',      oracleRound: 12 }

    // `schedules` is the price view each successive feeschedule call answers with (the
    // last one repeats); `quote` is what feequote answers, or an Error to throw.
    function connector(){
        return { call: async (method, params) => {
            calls.push({ method, params })
            if (method === 'feeschedule') {
                const n = calls.filter(c => c.method === 'feeschedule').length
                const p = schedules[Math.min(n, schedules.length) - 1]
                return {
                    nativeFeeEnabled: true, feeDestination: 'DFeeDest111',
                    prices: p ? Object.assign({ available: true }, p) : { available: false, error: 'no current oracle price for DOGE/USD' }
                }
            }
            if (method === 'feequote') {
                if (quote instanceof Error) throw quote
                return quote
            }
            throw new Error('unexpected method ' + method)
        }}
    }

    beforeEach(() => {
        savedSnapshotModule = require.cache[SNAPSHOT_PATH]
        savedCoin = global.COIN_CODE
        savedNetwork = global.NETWORK
        savedConnector = global.indexerConnector
        global.COIN_CODE = 'DOGE'
        global.NETWORK = 'regtest'
        calls = []
        seeded = []
        quote = null
        chainTime = Math.floor(Date.now() / 1000) + 60
        require.cache[SNAPSHOT_PATH] = { id: SNAPSHOT_PATH, filename: SNAPSHOT_PATH, loaded: true, exports: {
            isAvailable: async () => true,
            latestBlockTime: async () => chainTime,
            clearPair: async () => {},
            seedSnapshot: async (row) => { seeded.push(row) }
        }}
        global.indexerConnector = connector()
        savedLog = console.log
        console.log = () => {}
    })

    afterEach(() => {
        console.log = savedLog
        if (savedSnapshotModule) require.cache[SNAPSHOT_PATH] = savedSnapshotModule
        else delete require.cache[SNAPSHOT_PATH]
        global.COIN_CODE = savedCoin
        global.NETWORK = savedNetwork
        global.indexerConnector = savedConnector
        delete require.cache[HELPER_PATH]
    })

    const quotes = () => calls.filter(c => c.method === 'feequote')

    it('pays the flat fee at the seeded pair and asks for no quote', async () => {
        schedules = [SEED]
        const helper = freshHelper()
        assert.strictEqual(await helper.nativeFeeSats('ISSUE|0|TICK|1000|100|0|d|10', 'DSrc111'), helper.FLAT_FEE_SATS)
        assert.strictEqual(quotes().length, 0, 'the seed path must stay as cheap as it was')
        assert.strictEqual(seeded.length, 0, 'a visible seed must not be re-seeded')
    })

    it('sizes the fee to the action\'s own quote, with headroom, under a re-priced fixture', async () => {
        schedules = [REPRICED]
        quote = { supported: true, valid: true, requiredFeeSats: 200000 }   // 1 XCHAIN at DOGE/USD=1000
        const helper = freshHelper()
        const sats = await helper.nativeFeeSats('ISSUE|0|TICK|1000|100|0|d|10', 'DSrc111')
        assert.strictEqual(sats, Math.ceil(200000 * helper.FEE_HEADROOM))
        // The expected fee here is 0.002 DOGE, and the flat 0.0005 was what the indexer
        // rejected; the paid output has to clear the band's 0.95x floor with room to spare.
        assert(sats * 0.95 > 200000, 'the output must clear the band floor with headroom, got ' + sats)
        assert.deepStrictEqual(quotes()[0].params,
            { action: 'ISSUE', params: '0|TICK|1000|100|0|d|10', source: 'DSrc111' },
            'the quote must be for this exact action and sender')
        assert.strictEqual(seeded.length, 0, 'a fixture round is a suite\'s own re-price; it must not be clobbered')
    })

    it('never pays less than the flat floor, even when the quote is smaller', async () => {
        schedules = [REPRICED]
        quote = { supported: true, valid: true, requiredFeeSats: 1000 }
        const helper = freshHelper()
        assert.strictEqual(await helper.nativeFeeSats('SEND|0|T|1|x|', 'DSrc111'), helper.FLAT_FEE_SATS)
    })

    it('falls back to the re-priced budget when the indexer will not quote the action', async () => {
        schedules = [REPRICED]
        quote = new Error('invalid: TICK (already exists)')   // the connector throws on the error envelope
        const helper = freshHelper()
        const sats = await helper.nativeFeeSats('ISSUE|0|TICK|1000|100|0|d|10', 'DSrc111')
        // 25 XCHAIN at $2 / $1000 = 0.05 DOGE, plus headroom.
        assert.strictEqual(sats, Math.ceil(5000000 * helper.FEE_HEADROOM))
    })

    it('prices by budget when no action string is given (the SDK and multisig lanes)', async () => {
        schedules = [REPRICED]
        const helper = freshHelper()
        assert.strictEqual(await helper.nativeFeeSats(), Math.ceil(5000000 * helper.FEE_HEADROOM))
        assert.strictEqual(quotes().length, 0)
    })

    it('re-seeds when the indexer has fallen back to a live hub round, then pays the flat fee', async () => {
        // Before the fix: one ISSUE at the live DOGE/USD expected ~17.5 DOGE against a
        // 1-DOGE funded address, so no correct fee could even be built.
        schedules = [LIVE_HUB, SEED]
        const helper = freshHelper()
        assert.strictEqual(await helper.nativeFeeSats('ISSUE|0|TICK|1000|100|0|d|10', 'DSrc111'), helper.FLAT_FEE_SATS)
        assert(seeded.some(r => r.coinPair === 'DOGE/USD' && r.price === '100000.00000000'),
            'the seed must be written back: ' + JSON.stringify(seeded))
        assert.strictEqual(quotes().length, 0)
    })

    it('re-seeds when the indexer has no usable price at all', async () => {
        schedules = [null, SEED]
        const helper = freshHelper()
        assert.strictEqual(await helper.nativeFeeSats('ISSUE|0|T|1|1|0|d|1', 'DSrc111'), helper.FLAT_FEE_SATS)
        assert(seeded.length > 0, 'an unpriceable indexer must get the seed back')
    })

    it('rate-limits the displaced re-seed, and still prices a live round it could not displace', async () => {
        schedules = [LIVE_HUB]
        quote = { supported: true, valid: true, requiredFeeSats: 1752151752 }
        const helper = freshHelper()
        assert.strictEqual(await helper.nativeFeeSats('ISSUE|0|T|1|1|0|d|1', 'DSrc111'),
            Math.ceil(1752151752 * helper.FEE_HEADROOM), 'an unmovable live price is still paid correctly')
        const afterFirst = seeded.length
        assert(afterFirst > 0)
        await helper.nativeFeeSats('ISSUE|0|T|1|1|0|d|1', 'DSrc111')
        assert.strictEqual(seeded.length, afterFirst, 'a second displaced call inside the window must not re-seed')
    })

    it('keeps the flat fee when the indexer cannot answer at all', async () => {
        global.indexerConnector = { call: async () => { throw new Error('ECONNREFUSED') } }
        const helper = freshHelper()
        assert.strictEqual(await helper.nativeFeeSats('ISSUE|0|T|1|1|0|d|1', 'DSrc111'), helper.FLAT_FEE_SATS)
    })

    it('pays the flat floor for a fee-exempt action', async () => {
        schedules = [REPRICED]
        quote = { supported: true, valid: true, feeExempt: true, requiredFeeSats: 0 }
        const helper = freshHelper()
        assert.strictEqual(await helper.nativeFeeSats('DISPENSE|0|x', 'DSrc111'), helper.FLAT_FEE_SATS)
    })

    it('never re-seeds on a venue that publishes its own prices (XCHAIN_E2E_NO_PRICE_SEED=1)', async () => {
        const CONSTANTS_PATH = require.resolve('../../helpers/xchainPriceConstants')
        const savedFlag = process.env.XCHAIN_E2E_NO_PRICE_SEED
        process.env.XCHAIN_E2E_NO_PRICE_SEED = '1'
        delete require.cache[CONSTANTS_PATH]
        try {
            schedules = [LIVE_HUB]
            quote = { supported: true, valid: true, requiredFeeSats: 1752151752 }
            const helper = freshHelper()
            assert.strictEqual(await helper.nativeFeeSats('ISSUE|0|T|1|1|0|d|1', 'DSrc111'),
                Math.ceil(1752151752 * helper.FEE_HEADROOM))
            assert.strictEqual(seeded.length, 0, 'the live rounds ARE the prices on such a venue')
        } finally {
            if (savedFlag === undefined) delete process.env.XCHAIN_E2E_NO_PRICE_SEED
            else process.env.XCHAIN_E2E_NO_PRICE_SEED = savedFlag
            delete require.cache[CONSTANTS_PATH]
        }
    })

    it('getNativeFeeOutput stays null on gas-mode BTC and reads no prices for sizing', async () => {
        global.COIN_CODE = 'BTC'
        global.indexerConnector = { call: async (method) => {
            calls.push({ method })
            return { nativeFeeEnabled: false, feeDestination: null, prices: { available: false } }
        }}
        const helper = freshHelper()
        assert.strictEqual(await helper.getNativeFeeOutput('ISSUE|0|T|1|1|0|d|1', 'bSrc'), null)
        assert.strictEqual(quotes().length, 0)
    })

    it('getNativeFeeOutput carries the sized value to the discovered destination', async () => {
        schedules = [REPRICED]
        quote = { supported: true, valid: true, requiredFeeSats: 200000 }
        const helper = freshHelper()
        const out = await helper.getNativeFeeOutput('ISSUE|0|TICK|1000|100|0|d|10', 'DSrc111')
        assert.deepStrictEqual(out, { address: 'DFeeDest111', value: Math.ceil(200000 * helper.FEE_HEADROOM) })
    })
})
