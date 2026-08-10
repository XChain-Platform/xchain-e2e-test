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

// . The two price helpers seed DIFFERENTLY on purpose, and the asymmetry is
// easy to "tidy" back into a bug, so it is pinned here.
//
//   oracle_prices    seeds UPSTREAM (the hub) when a mirror is in play, because
//                    the hub has a write path that broadcasts (`pushoracleprice`
//                    -> PriceAggregator -> row:inserted -> subscribers).
//   price_snapshots  ALWAYS seeds the copy settlement reads, because its only
//                    broadcasting writer is OracleConsensus, i.e. a validator
//                    federation, which no regtest stack runs. Seeding it upstream
//                    would simply never arrive.
//
// These cases stub the helpers' own methods rather than injecting a fake mariadb
// into require.cache. That injection style is what produced the  load-order
// trap, where a suite only passed while it was the first file to require db.js.

const assert = require('assert')

const ORACLE_PATH = require.resolve('../../helpers/oraclePriceHelper')
const SNAPSHOT_PATH = require.resolve('../../helpers/priceSnapshotHelper')
const TOPOLOGY_PATH = require.resolve('../../helpers/hubMirrorTopology')

const ENV_KEYS = ['HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_SOURCE_DB_NAME']

const LOCAL = { host: 'mariadb', port: 3306, dbName: 'XChain_BTC_Regtest_Indexer', user: 'idx', pass: 'p' }

function freshHelpers(){
    for (const p of [ORACLE_PATH, SNAPSHOT_PATH, TOPOLOGY_PATH]) delete require.cache[p]
    return { oracle: require(ORACLE_PATH), snapshot: require(SNAPSHOT_PATH) }
}

function enableMirror(){
    process.env.HUB_DB_HOST = 'mariadb'
    process.env.HUB_DB_NAME = 'XChain_Hub_Mirror'
    process.env.HUB_SOURCE_DB_NAME = 'XChain_Hub'
}

describe('price seed routing ', () => {
    const savedEnv = {}
    let savedIndexerDb, savedHubConnector

    beforeEach(() => {
        for (const k of ENV_KEYS){ savedEnv[k] = process.env[k]; delete process.env[k] }
        savedIndexerDb = global.indexerDatabase
        savedHubConnector = global.hubConnector
        global.indexerDatabase = Object.assign({}, LOCAL)
    })

    afterEach(() => {
        for (const k of ENV_KEYS){
            if (savedEnv[k] === undefined) delete process.env[k]
            else process.env[k] = savedEnv[k]
        }
        global.indexerDatabase = savedIndexerDb
        global.hubConnector = savedHubConnector
    })

    describe('priceSnapshotHelper never seeds upstream', () => {
        it('writes where settlement reads on the single-host stack', () => {
            const { snapshot } = freshHelpers()
            assert.deepStrictEqual(snapshot.seedTarget(), snapshot.readTarget())
            assert.strictEqual(snapshot.seedsThroughMirror(), false)
        })

        // The load-bearing one. Even with a hub named, the validator snapshot must
        // still be written into the mirror, because nothing would ever carry it
        // down from the hub. A helper that "correctly" seeded upstream here would
        // hang every Mode A case for its full timeout.
        it('writes into the mirror, not the hub, when the mirror is configured', () => {
            enableMirror()
            const { snapshot } = freshHelpers()
            assert.strictEqual(snapshot.seedTarget().database, 'XChain_Hub_Mirror')
            assert.strictEqual(snapshot.readTarget().database, 'XChain_Hub_Mirror')
            assert.strictEqual(snapshot.seedsThroughMirror(), false,
                'no wait should be armed, since there is nothing to replicate')
        })
    })

    describe('oraclePriceHelper seeds upstream once a mirror exists', () => {
        it('writes directly to the indexer DB on the single-host stack', () => {
            const { oracle } = freshHelpers()
            assert.deepStrictEqual(oracle.seedTarget(), oracle.readTarget())
            assert.strictEqual(oracle.seedsThroughMirror(), false)
        })

        it('writes to the hub and reads the mirror once both are named', () => {
            enableMirror()
            const { oracle } = freshHelpers()
            assert.strictEqual(oracle.seedTarget().database, 'XChain_Hub')
            assert.strictEqual(oracle.readTarget().database, 'XChain_Hub_Mirror')
            assert.strictEqual(oracle.seedsThroughMirror(), true)
        })
    })

    describe('seedQuote mechanism selection', () => {
        it('routes through the hub push path when a mirror is in play', async () => {
            enableMirror()
            const { oracle } = freshHelpers()
            let pushed = null, waited = null
            oracle.pushQuoteViaHub = async (args) => { pushed = args }
            oracle.waitForMirror   = async (args) => { waited = args; return { mirrored: true } }

            await oracle.seedQuote({
                sourceAddress: 'bcrt1qexample', sourceChain: 'BTC',
                coin: 'BTC', tick: 'MIRRORTEST', fiat: 'MXN',
                value: '100.00000000', fee: '0',
                effectiveAt: 1800000000, actionIndex: 999000708
            })

            assert(pushed, 'the hub push path should be used, not a direct INSERT')
            // The whole point of deriving block_time: the hub adds 86400
            // unconditionally, so this is what makes the quote land on exactly the
            // effective_at the caller asked for, with no mock-time driver.
            assert.strictEqual(pushed.blockTime, 1800000000 - 86400,
                'block_time must be back-dated so the hub derives the requested effective_at')
            assert.strictEqual(pushed.value, '100.00000000')
            assert.strictEqual(pushed.actionIndex, 999000708)
            assert(waited, 'seeding must not return before the row has been mirrored')
        })

        it('does not use the hub push path on the single-host stack', async () => {
            const { oracle } = freshHelpers()
            let pushCalls = 0
            oracle.pushQuoteViaHub = async () => { pushCalls++ }
            oracle.waitForMirror   = async () => ({ mirrored: true })

            // Falls through to the direct-INSERT branch, which has no database to
            // reach in a unit run. The connection failure is the expected outcome;
            // what is being asserted is that the hub path was not taken.
            try {
                await oracle.seedQuote({
                    sourceAddress: 'bcrt1qexample', sourceChain: 'BTC',
                    coin: 'BTC', tick: 'LOCALTEST', fiat: 'MXN',
                    value: '1.00000000', fee: '0',
                    effectiveAt: 1800000000, actionIndex: 999000709
                })
            } catch (e){ /* no DB in a unit run */ }

            assert.strictEqual(pushCalls, 0, 'a direct seed must not go through the hub')
        })
    })

    describe('pushQuoteViaHub', () => {
        function stubHub(captured){
            global.hubConnector = { _call: async (body) => { captured.body = body; return { accepted: true } } }
        }

        it('advances push_generation past whatever the hub already holds', async () => {
            enableMirror()
            const { oracle } = freshHelpers()
            const captured = {}
            stubHub(captured)
            // A previous run left generation 4 at this action_index. The hub's
            // upsert is generation-fenced, so re-pushing at 4 would be refused as a
            // duplicate and the test would silently price against the old value.
            oracle.currentPushGeneration = async () => 4

            await oracle.pushQuoteViaHub({
                sourceAddress: 'bcrt1qexample', sourceChain: 'BTC',
                coin: 'BTC', tick: 'GENTEST', fiat: 'MXN',
                value: '3.00000000', blockTime: 1700000000, actionIndex: 999000708
            })

            assert.strictEqual(captured.body.method, 'pushoracleprice')
            assert.strictEqual(captured.body.params.push_generation, 5)
            assert.strictEqual(captured.body.params.block_time, 1700000000)
        })

        // The second fence, and the easy one to miss. receiveOraclePrice consults
        // price_ingest_watermarks BEFORE it looks for an existing row, so once any
        // reorg retraction has been recorded on the chain, a generation-0 push is
        // refused as 'stale (retracted generation)' even with no row present. The
        // fixtures' synthetic action_index values are huge, so they always sit
        // inside the fenced range.
        it('clears the retraction fence even when no row exists', async () => {
            enableMirror()
            const { oracle } = freshHelpers()
            const captured = {}
            stubHub(captured)
            oracle.currentPushGeneration = async () => 7   // watermark-derived floor

            await oracle.pushQuoteViaHub({
                sourceAddress: 'bcrt1qexample', sourceChain: 'BTC',
                coin: 'BTC', tick: 'FENCED', fiat: 'MXN',
                value: '3.00000000', blockTime: 1700000000, actionIndex: 999000708
            })
            assert.strictEqual(captured.body.params.push_generation, 8)
        })

        it('starts at generation 0 when the hub holds no such row', async () => {
            enableMirror()
            const { oracle } = freshHelpers()
            const captured = {}
            stubHub(captured)
            oracle.currentPushGeneration = async () => -1

            await oracle.pushQuoteViaHub({
                sourceAddress: 'bcrt1qexample', sourceChain: 'BTC',
                coin: 'BTC', tick: 'GENTEST', fiat: 'MXN',
                value: '3.00000000', blockTime: 1700000000, actionIndex: 999000710
            })
            assert.strictEqual(captured.body.params.push_generation, 0)
        })

        // A refused push must be loud. Accepting it silently would leave the
        // PREVIOUS run's value in place and settle the test against it, which
        // presents as a wrong credited amount with no hint of a fixture problem.
        it('throws rather than continuing when the hub refuses the quote', async () => {
            enableMirror()
            const { oracle } = freshHelpers()
            global.hubConnector = { _call: async () => ({ accepted: false, reason: 'duplicate' }) }
            oracle.currentPushGeneration = async () => 0

            await assert.rejects(
                () => oracle.pushQuoteViaHub({
                    sourceAddress: 'bcrt1qexample', sourceChain: 'BTC',
                    coin: 'BTC', tick: 'DUPE', fiat: 'MXN',
                    value: '3.00000000', blockTime: 1700000000, actionIndex: 999000708
                }),
                /did not accept the quote \(duplicate\)/)
        })

        it('reports an unreachable hub distinctly from a refusal', async () => {
            enableMirror()
            const { oracle } = freshHelpers()
            global.hubConnector = { _call: async () => null }
            oracle.currentPushGeneration = async () => 0

            await assert.rejects(
                () => oracle.pushQuoteViaHub({
                    sourceAddress: 'bcrt1qexample', sourceChain: 'BTC',
                    coin: 'BTC', tick: 'DOWN', fiat: 'MXN',
                    value: '3.00000000', blockTime: 1700000000, actionIndex: 999000711
                }),
                /hub returned no result/)
        })
    })
})
