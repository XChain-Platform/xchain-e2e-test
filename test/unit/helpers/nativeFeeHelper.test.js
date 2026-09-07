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
})
