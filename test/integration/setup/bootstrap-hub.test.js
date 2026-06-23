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

// Integration tests for the hub discovery fallback path in initialCheck.test.js.
//
// When env vars are incomplete, the bootstrap falls back to XChainHubConnector
// to discover all service endpoints. These tests verify that hub config responses
// are correctly mapped to connector constructor arguments.

const assert = require('assert')
const sinon = require('sinon')
const axios = require('axios')

require('../fixtures/mockMariadb')

const XChainHubConnector = require('../../../src/XChainHubConnector')
const BlockchainConnector = require('../../../src/BlockchainConnector')
const XChainUtxoTrackerConnector = require('../../../src/XChainUtxoTrackerConnector')
const XChainEncoderConnector = require('../../../src/XChainEncoderConnector')
const XChainIndexerConnector = require('../../../src/XChainIndexerConnector')
const RegtestMinerConnector = require('../../../src/RegtestMinerConnector')
const Database = require('../../../src/db')
const CryptoNetworks = require('../../../src/CryptoNetworks')

const hubFixtures = require('../fixtures/hub')

describe('Bootstrap: hub discovery fallback', function () {

    let savedGlobals
    let axiosStub

    beforeEach(function () {
        savedGlobals = {
            COIN: global.COIN,
            NETWORK: global.NETWORK,
            NETWORK_OBJECT: global.NETWORK_OBJECT,
            COIN_CODE: global.COIN_CODE,
            nodeConnector: global.nodeConnector,
            utxoTrackerConnector: global.utxoTrackerConnector,
            encoderConnector: global.encoderConnector,
            indexerConnector: global.indexerConnector,
            indexerDatabase: global.indexerDatabase,
            regtestMinerConnector: global.regtestMinerConnector,
            hubConnector: global.hubConnector,
        }
        axiosStub = sinon.stub(axios, 'post')
    })

    afterEach(function () {
        Object.assign(global, savedGlobals)
        sinon.restore()
    })

    // Replicate the hub fallback bootstrap from initialCheck.test.js lines 100-158
    async function bootstrapFromHub(coin, network) {
        global.COIN = coin
        global.NETWORK = network
        global.NETWORK_OBJECT = CryptoNetworks.getBitcoinJsNetwork(coin + '-' + network)
        const COIN_CODE_MAP = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' }
        global.COIN_CODE = COIN_CODE_MAP[coin] || coin.toUpperCase().slice(0, 3)

        let hubEndpoints = XChainHubConnector.parseEndpoints()
        global.hubConnector = new XChainHubConnector(hubEndpoints)
        let pingHub = await global.hubConnector.ping()

        if (!pingHub) {
            throw new Error("Can't connect to the XChain Hub")
        }

        let hubConfigs = await global.hubConnector.getAllConfig()
        if (!hubConfigs) {
            throw new Error('There was an error trying to get all the configs from the hub')
        }

        // initialCheck.js overrides all hosts to "localhost" (Docker convention)
        const NODE_URL = 'localhost'
        const NODE_PORT = hubConfigs[coin][network]['node']['server_port']
        const NODE_USER = hubConfigs[coin][network]['node']['user']
        const NODE_PASS = hubConfigs[coin][network]['node']['pass']
        const DATABASE_URL = 'localhost'
        const DATABASE_PORT = hubConfigs[coin][network]['database']['port']
        const UTXO_TRACKER_URL = 'localhost'
        const UTXO_TRACKER_PORT = hubConfigs[coin][network]['xchain-utxo-tracker']['server_port']
        const ENCODER_URL = 'localhost'
        const ENCODER_PORT = hubConfigs[coin][network]['xchain-encoder']['server_port']
        const INDEXER_URL = 'localhost'
        const INDEXER_PORT = hubConfigs[coin][network]['xchain-indexer']['server_port']
        const INDEXER_DATABASE_NAME = hubConfigs[coin][network]['xchain-indexer']['name']
        const INDEXER_DATABASE_USER = hubConfigs[coin][network]['xchain-indexer']['user']
        const INDEXER_DATABASE_PASS = hubConfigs[coin][network]['xchain-indexer']['pass']
        const REGTEST_MINER_URL = 'localhost'
        const REGTEST_MINER_PORT = hubConfigs[coin][network]['xchain-regtest-miner']['server_port']

        global.nodeConnector = new BlockchainConnector(NODE_URL, NODE_PORT, NODE_USER, NODE_PASS)
        global.utxoTrackerConnector = new XChainUtxoTrackerConnector(UTXO_TRACKER_URL, UTXO_TRACKER_PORT)
        global.encoderConnector = new XChainEncoderConnector(ENCODER_URL, ENCODER_PORT)
        global.indexerConnector = new XChainIndexerConnector(INDEXER_URL, INDEXER_PORT)
        global.indexerDatabase = new Database(DATABASE_URL, DATABASE_PORT, INDEXER_DATABASE_NAME, INDEXER_DATABASE_USER, INDEXER_DATABASE_PASS)
        global.regtestMinerConnector = new RegtestMinerConnector(REGTEST_MINER_URL, REGTEST_MINER_PORT, process.env.MINER_API_KEY || null)
    }

    describe('Scenario 3.1.2: Hub provides all service endpoints', function () {

        it('initializes connectors from hub config', async function () {
            axiosStub.onFirstCall().resolves({ data: { jsonrpc: '2.0', result: true, id: 1 } })
            axiosStub.onSecondCall().resolves({ data: { jsonrpc: '2.0', result: { configs: hubFixtures.validConfig, seq: 0, watermark: 0 }, id: 1 } })

            process.env.HUB_URL = 'hubhost'
            process.env.HUB_PORT = '10000'

            await bootstrapFromHub('bitcoin', 'regtest')

            assert.strictEqual(global.nodeConnector.url, 'http://localhost:18443')
            assert.strictEqual(global.nodeConnector.rpcUser, 'rpcuser')
            assert.strictEqual(global.nodeConnector.rpcPassword, 'rpcpass')

            assert.strictEqual(global.utxoTrackerConnector.url, 'http://localhost:3030')
            assert.strictEqual(global.encoderConnector.url, 'http://localhost:3031')
            assert.strictEqual(global.indexerConnector.url, 'http://localhost:3032')
            assert.strictEqual(global.regtestMinerConnector.url, 'http://localhost:3033')

            assert.strictEqual(global.indexerDatabase.host, 'localhost')
            assert.strictEqual(global.indexerDatabase.port, 3306)
            assert.strictEqual(global.indexerDatabase.dbName, 'XChain_BTC_Regtest_Indexer')
            assert.strictEqual(global.indexerDatabase.user, 'indexer_user')
            assert.strictEqual(global.indexerDatabase.pass, 'indexer_pass')

            delete process.env.HUB_URL
            delete process.env.HUB_PORT
        })
    })

    describe('Scenario 3.7.4: Hub unreachable', function () {

        it('throws when hub ping fails', async function () {
            // All axios calls fail
            axiosStub.rejects(new Error('ECONNREFUSED'))

            process.env.HUB_URL = 'badhost'
            process.env.HUB_PORT = '10000'

            await assert.rejects(
                () => bootstrapFromHub('bitcoin', 'regtest'),
                { message: "Can't connect to the XChain Hub" }
            )

            delete process.env.HUB_URL
            delete process.env.HUB_PORT
        })

        it('throws when hub returns null config', async function () {
            axiosStub.onFirstCall().resolves({ data: { jsonrpc: '2.0', result: true, id: 1 } })
            axiosStub.onSecondCall().resolves({ data: { jsonrpc: '2.0', result: null, id: 1 } })

            process.env.HUB_URL = 'hubhost'
            process.env.HUB_PORT = '10000'

            await assert.rejects(
                () => bootstrapFromHub('bitcoin', 'regtest'),
                (err) => {
                    assert(err.message.includes('error') || err instanceof TypeError)
                    return true
                }
            )

            delete process.env.HUB_URL
            delete process.env.HUB_PORT
        })
    })

    describe('Scenario: Hub parseEndpoints reads env vars', function () {

        it('builds endpoint from HUB_URL and HUB_PORT', function () {
            process.env.HUB_URL = 'myhub'
            process.env.HUB_PORT = '9999'
            delete process.env.HUB_VALIDATORS

            const endpoints = XChainHubConnector.parseEndpoints()

            assert.deepStrictEqual(endpoints, ['http://myhub:9999'])

            delete process.env.HUB_URL
            delete process.env.HUB_PORT
        })

        it('splits HUB_VALIDATORS into multiple endpoints', function () {
            process.env.HUB_VALIDATORS = 'http://hub1:10000, hub2:10001, http://hub3:10002'

            const endpoints = XChainHubConnector.parseEndpoints()

            assert.deepStrictEqual(endpoints, [
                'http://hub1:10000',
                'http://hub2:10001',
                'http://hub3:10002',
            ])

            delete process.env.HUB_VALIDATORS
        })
    })
})
