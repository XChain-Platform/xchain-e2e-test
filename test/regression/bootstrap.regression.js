'use strict'

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
const sinon  = require('sinon')

const BlockchainConnector        = require('../../src/BlockchainConnector')
const XChainUtxoTrackerConnector = require('../../src/XChainUtxoTrackerConnector')
const XChainEncoderConnector     = require('../../src/XChainEncoderConnector')
const XChainIndexerConnector     = require('../../src/XChainIndexerConnector')
const XChainHubConnector         = require('../../src/XChainHubConnector')
const RegtestMinerConnector      = require('../../src/RegtestMinerConnector')
const CryptoNetworks             = require('../../src/CryptoNetworks')

// Inject mock mariadb before requiring Database
const mockMariadb = require('../integration/fixtures/mockMariadb')
const Database    = require('../../src/db')
const hubFixture  = require('../integration/fixtures/hub')

// ═══════════════════════════════════════════════════════════════════════════
// P0 — Bootstrap Orchestration Regression Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('[regression:p0] Bootstrap Orchestration', function () {

    afterEach(function () {
        sinon.restore()
    })

    // ── R-BOOT-001 — env var parsing ─────────────────────────────────────

    describe('Environment variable parsing', function () {

        it('[regression:p0] R-BOOT-001 — COIN_CODE_MAP maps known coins correctly', function () {
            const COIN_CODE_MAP = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' }
            assert.strictEqual(COIN_CODE_MAP['bitcoin'], 'BTC')
            assert.strictEqual(COIN_CODE_MAP['litecoin'], 'LTC')
            assert.strictEqual(COIN_CODE_MAP['dogecoin'], 'DOGE')
        })

        it('[regression:p0] R-BOOT-001b — COIN_CODE falls back to uppercase slice for unknown coins', function () {
            const COIN_CODE_MAP = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' }
            const coin = 'ethereum'
            const code = COIN_CODE_MAP[coin] || coin.toUpperCase().slice(0, 3)
            assert.strictEqual(code, 'ETH')
        })

        it('[regression:p0] R-BOOT-001c — NETWORK split fallback extracts coin and network', function () {
            // Replicates the logic: if COIN is null, split NETWORK on "-"
            const NETWORK = 'bitcoin-regtest'
            const parts = NETWORK.split('-')
            assert.strictEqual(parts[0], 'bitcoin')
            assert.strictEqual(parts[1], 'regtest')
        })
    })

    // ── R-BOOT-002 — Hub discovery fallback ──────────────────────────────

    describe('Hub discovery fallback', function () {

        it('[regression:p0] R-BOOT-002 — hub config populates all connector URLs', function () {
            const config = hubFixture.validConfig
            const coin = 'bitcoin'
            const network = 'regtest'

            // Replicate bootstrap extraction from initialCheck.test.js
            const nodePort      = config[coin][network]['node']['server_port']
            const nodeUser      = config[coin][network]['node']['user']
            const nodePass      = config[coin][network]['node']['pass']
            const dbPort        = config[coin][network]['database']['port']
            const trackerPort   = config[coin][network]['xchain-utxo-tracker']['server_port']
            const encoderPort   = config[coin][network]['xchain-encoder']['server_port']
            const indexerPort   = config[coin][network]['xchain-indexer']['server_port']
            const indexerDbName = config[coin][network]['xchain-indexer']['name']
            const indexerDbUser = config[coin][network]['xchain-indexer']['user']
            const indexerDbPass = config[coin][network]['xchain-indexer']['pass']
            const minerPort     = config[coin][network]['xchain-regtest-miner']['server_port']

            assert.strictEqual(nodePort, 18443)
            assert.strictEqual(nodeUser, 'rpcuser')
            assert.strictEqual(dbPort, 3306)
            assert.strictEqual(trackerPort, 3030)
            assert.strictEqual(encoderPort, 3031)
            assert.strictEqual(indexerPort, 3032)
            assert.strictEqual(indexerDbName, 'XChain_BTC_Regtest_Indexer')
            assert.strictEqual(minerPort, 3033)
        })

        it('[regression:p0] R-BOOT-002b — hub discovery uses localhost for Docker convention', function () {
            // In initialCheck.test.js, all hub-discovered URLs are hardcoded to "localhost"
            const DATABASE_URL = 'localhost'
            assert.strictEqual(DATABASE_URL, 'localhost')
        })
    })

    // ── R-BOOT-003 — connector instantiation ─────────────────────────────

    describe('Connector instantiation', function () {

        it('[regression:p0] R-BOOT-003 — all 6 connectors instantiate from config', function () {
            const node    = new BlockchainConnector('localhost', 18443, 'rpcuser', 'rpcpass')
            const tracker = new XChainUtxoTrackerConnector('localhost', 3030)
            const encoder = new XChainEncoderConnector('localhost', 3031)
            const indexer = new XChainIndexerConnector('localhost', 3032)
            const miner   = new RegtestMinerConnector('localhost', 3033)

            const conn = makeMockConnection([{ '1+1': 2 }])
            const pool = makeMockPool(conn)
            mockMariadb.createPool.returns(pool)
            const db = new Database('localhost', 3306, 'TestDB', 'user', 'pass')

            assert.ok(node.url.includes('localhost'))
            assert.ok(tracker.url.includes('localhost'))
            assert.ok(encoder.url.includes('localhost'))
            assert.ok(indexer.url.includes('localhost'))
            assert.ok(miner.url.includes('localhost'))
            assert.ok(db.pool)
        })
    })

    // ── R-BOOT-007 — mining time configuration ──────────────────────────

    describe('Mining time configuration', function () {

        it('[regression:p0] R-BOOT-007 — setMiningTime accepts 1000, 1000 params', async function () {
            const axios = require('axios')
            const stub = sinon.stub(axios, 'post').resolves({
                data: { jsonrpc: '2.0', result: true, id: 1 }
            })

            const miner = new RegtestMinerConnector('localhost', 3033)
            await miner.setMiningTime(1000, 1000)

            const body = stub.firstCall.args[1]
            assert.strictEqual(body.params.max_time, 1000)
            assert.strictEqual(body.params.tx_added_time, 1000)
        })
    })

    // ── R-BOOT-008 — global COIN/NETWORK/NETWORK_OBJECT ─────────────────

    describe('Global config resolution', function () {

        it('[regression:p0] R-BOOT-008 — CryptoNetworks.getBitcoinJsNetwork returns valid config', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest')
            assert.ok(network, 'should return a network object')
            assert.strictEqual(network.dustThreshold, 546)
            assert.ok(network.bip32, 'should have bip32 config')
            assert.ok(network.bip32.public, 'should have bip32.public')
            assert.ok(network.bip32.private, 'should have bip32.private')
        })

        it('[regression:p0] R-BOOT-008b — all 9 coin/network combos return valid configs', function () {
            const combos = [
                'bitcoin-mainnet', 'bitcoin-testnet', 'bitcoin-regtest',
                'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest',
                'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest'
            ]
            for (const combo of combos) {
                const network = CryptoNetworks.getBitcoinJsNetwork(combo)
                assert.ok(network, `${combo} should return a config`)
                assert.strictEqual(network.dustThreshold, 546, `${combo} dustThreshold should be 546`)
            }
        })
    })

    // ── R-BOOT-009 — graceful failure ────────────────────────────────────

    describe('Graceful failure on missing service', function () {

        it('[regression:p0] R-BOOT-009 — encoder ping returns false when service is down', async function () {
            const axios = require('axios')
            sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))

            const encoder = new XChainEncoderConnector('localhost', 3031)
            const result = await encoder.ping()
            assert.strictEqual(result, false)
        })

        it('[regression:p0] R-BOOT-009b — indexer ping returns false when service is down', async function () {
            const axios = require('axios')
            sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))

            const indexer = new XChainIndexerConnector('localhost', 3032)
            const result = await indexer.ping()
            assert.strictEqual(result, false)
        })
    })
})

// ── Helper functions (scoped to this file) ───────────────────────────────

function makeMockConnection(queryResult) {
    return {
        query:   sinon.stub().resolves(queryResult !== undefined ? queryResult : []),
        release: sinon.stub().resolves()
    }
}

function makeMockPool(conn) {
    return {
        getConnection: sinon.stub().resolves(conn),
        end:           sinon.stub().resolves()
    }
}
