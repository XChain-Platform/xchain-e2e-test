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

// Integration tests for initialCheck.test.js: environment variable bootstrap path.
//
// initialCheck.js has deep side effects at require-time (reads process.env, sets globals,
// requires connector classes). We cannot require it directly in integration tests.
// Instead, we replicate the bootstrap logic and test it against the real connector
// constructors to verify the integration between env parsing and connector initialization.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')

require('../fixtures/mockMariadb')

const BlockchainConnector = require('../../../src/BlockchainConnector')
const XChainUtxoTrackerConnector = require('../../../src/XChainUtxoTrackerConnector')
const XChainEncoderConnector = require('../../../src/XChainEncoderConnector')
const XChainDecoderConnector = require('../../../src/XChainDecoderConnector')
const XChainIndexerConnector = require('../../../src/XChainIndexerConnector')
const XChainExplorerConnector = require('../../../src/XChainExplorerConnector')
const RegtestMinerConnector = require('../../../src/RegtestMinerConnector')
const Database = require('../../../src/db')
const CryptoNetworks = require('../../../src/CryptoNetworks')

describe('Bootstrap: environment variable path', function () {

    let savedGlobals

    beforeEach(function () {
        savedGlobals = {
            COIN: global.COIN,
            NETWORK: global.NETWORK,
            NETWORK_OBJECT: global.NETWORK_OBJECT,
            COIN_CODE: global.COIN_CODE,
            nodeConnector: global.nodeConnector,
            utxoTrackerConnector: global.utxoTrackerConnector,
            encoderConnector: global.encoderConnector,
            decoderConnector: global.decoderConnector,
            indexerConnector: global.indexerConnector,
            explorerConnector: global.explorerConnector,
            indexerDatabase: global.indexerDatabase,
            regtestMinerConnector: global.regtestMinerConnector,
            hubConnector: global.hubConnector,
        }
    })

    afterEach(function () {
        Object.assign(global, savedGlobals)
        sinon.restore()
    })

    // Replicate the bootstrap sequence from initialCheck.test.js lines 17-158
    function bootstrapFromEnv(envVars) {
        const COIN = envVars.COIN
        const NETWORK = envVars.NETWORK
        const NETWORK_OBJECT = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK)
        const COIN_CODE_MAP = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' }
        const COIN_CODE = COIN_CODE_MAP[COIN] || COIN.toUpperCase().slice(0, 3)

        global.COIN = COIN
        global.NETWORK = NETWORK
        global.NETWORK_OBJECT = NETWORK_OBJECT
        global.COIN_CODE = COIN_CODE

        global.nodeConnector = new BlockchainConnector(
            envVars.NODE_URL, envVars.NODE_PORT, envVars.NODE_USER, envVars.NODE_PASSWORD
        )
        global.utxoTrackerConnector = new XChainUtxoTrackerConnector(
            envVars.UTXO_TRACKER_URL, envVars.UTXO_TRACKER_API_PORT
        )
        global.encoderConnector = new XChainEncoderConnector(
            envVars.ENCODER_URL, envVars.ENCODER_API_PORT
        )
        global.decoderConnector = new XChainDecoderConnector(
            envVars.DECODER_URL, envVars.DECODER_API_PORT
        )
        global.indexerConnector = new XChainIndexerConnector(
            envVars.INDEXER_URL, envVars.INDEXER_API_PORT
        )
        global.explorerConnector = new XChainExplorerConnector(
            envVars.EXPLORER_URL, envVars.EXPLORER_API_PORT
        )
        global.indexerDatabase = new Database(
            envVars.DATABASE_URL || 'mariadb', envVars.DATABASE_PORT || 3306,
            envVars.INDEXER_DB_NAME, envVars.INDEXER_DB_USER, envVars.INDEXER_DB_PASS
        )
        global.regtestMinerConnector = new RegtestMinerConnector(
            envVars.REGTEST_MINER_URL, envVars.REGTEST_MINER_API_PORT, process.env.MINER_API_KEY || null
        )

        return { COIN, NETWORK, NETWORK_OBJECT, COIN_CODE }
    }

    const fullEnv = {
        COIN: 'bitcoin',
        NETWORK: 'regtest',
        NODE_URL: '127.0.0.1',
        NODE_PORT: '18443',
        NODE_USER: 'rpcuser',
        NODE_PASSWORD: 'rpcpass',
        UTXO_TRACKER_URL: '127.0.0.1',
        UTXO_TRACKER_API_PORT: '3030',
        ENCODER_URL: '127.0.0.1',
        ENCODER_API_PORT: '3031',
        DECODER_URL: '127.0.0.1',
        DECODER_API_PORT: '3034',
        INDEXER_URL: '127.0.0.1',
        INDEXER_API_PORT: '3032',
        EXPLORER_URL: '127.0.0.1',
        EXPLORER_API_PORT: '3035',
        INDEXER_DB_NAME: 'XChain_BTC_Regtest_Indexer',
        INDEXER_DB_USER: 'root',
        INDEXER_DB_PASS: 'password',
        REGTEST_MINER_URL: '127.0.0.1',
        REGTEST_MINER_API_PORT: '3033',
    }

    describe('Scenario 3.1.1: Full bootstrap with all env vars (bitcoin-regtest)', function () {

        it('initializes all 8 global connectors with correct URLs', function () {
            bootstrapFromEnv(fullEnv)

            assert(global.nodeConnector instanceof BlockchainConnector)
            assert.strictEqual(global.nodeConnector.url, 'http://127.0.0.1:18443')

            assert(global.utxoTrackerConnector instanceof XChainUtxoTrackerConnector)
            assert.strictEqual(global.utxoTrackerConnector.url, 'http://127.0.0.1:3030')

            assert(global.encoderConnector instanceof XChainEncoderConnector)
            assert.strictEqual(global.encoderConnector.url, 'http://127.0.0.1:3031')

            assert(global.decoderConnector instanceof XChainDecoderConnector)
            assert.strictEqual(global.decoderConnector.url, 'http://127.0.0.1:3034')

            assert(global.indexerConnector instanceof XChainIndexerConnector)
            assert.strictEqual(global.indexerConnector.url, 'http://127.0.0.1:3032')

            assert(global.explorerConnector instanceof XChainExplorerConnector)
            assert.strictEqual(global.explorerConnector.url, 'http://127.0.0.1:3035')

            assert(global.indexerDatabase instanceof Database)
            assert.strictEqual(global.indexerDatabase.host, 'mariadb')
            assert.strictEqual(global.indexerDatabase.port, 3306)
            assert.strictEqual(global.indexerDatabase.dbName, 'XChain_BTC_Regtest_Indexer')

            assert(global.regtestMinerConnector instanceof RegtestMinerConnector)
            assert.strictEqual(global.regtestMinerConnector.url, 'http://127.0.0.1:3033')
        })

        it('sets global COIN, NETWORK, NETWORK_OBJECT, COIN_CODE', function () {
            const result = bootstrapFromEnv(fullEnv)

            assert.strictEqual(result.COIN, 'bitcoin')
            assert.strictEqual(result.NETWORK, 'regtest')
            assert.strictEqual(result.COIN_CODE, 'BTC')
            assert.strictEqual(result.NETWORK_OBJECT.pubKeyHash, bitcoin.networks.regtest.pubKeyHash)
            assert.strictEqual(result.NETWORK_OBJECT.dustThreshold, 546)
        })
    })

    describe('Scenario 3.1.4: COIN/NETWORK parsing for litecoin', function () {

        it('initializes correctly for litecoin-regtest', function () {
            const ltcEnv = { ...fullEnv, COIN: 'litecoin', NETWORK: 'regtest' }
            const result = bootstrapFromEnv(ltcEnv)

            assert.strictEqual(result.COIN, 'litecoin')
            assert.strictEqual(result.NETWORK, 'regtest')
            assert.strictEqual(result.COIN_CODE, 'LTC')
            assert.strictEqual(result.NETWORK_OBJECT.pubKeyHash, 0x6f)
            // Litecoin's dust relay fee is 10× Bitcoin's → 5460 litoshi floor
            assert.strictEqual(result.NETWORK_OBJECT.dustThreshold, 5460)
        })

        it('initializes correctly for dogecoin-regtest', function () {
            const dogeEnv = { ...fullEnv, COIN: 'dogecoin', NETWORK: 'regtest' }
            const result = bootstrapFromEnv(dogeEnv)

            assert.strictEqual(result.COIN, 'dogecoin')
            assert.strictEqual(result.NETWORK, 'regtest')
            assert.strictEqual(result.COIN_CODE, 'DOGE')
            // Dogecoin v1.14 regtest uses Bitcoin-testnet-style prefixes
            // (0x6f), NOT the Dogecoin testnet prefix 0x71; dogecoind
            // rejects 0x71 regtest addresses (CryptoNetworks.js, 10ca0c6).
            assert.strictEqual(result.NETWORK_OBJECT.pubKeyHash, 0x6f)
        })
    })

    describe('Scenario 3.1.1: Connector URLs are derived correctly from env vars', function () {

        it('BlockchainConnector builds auth credentials from NODE_USER/NODE_PASSWORD', function () {
            bootstrapFromEnv(fullEnv)

            assert.strictEqual(global.nodeConnector.rpcUser, 'rpcuser')
            assert.strictEqual(global.nodeConnector.rpcPassword, 'rpcpass')
        })

        it('Database receives correct connection parameters', function () {
            bootstrapFromEnv(fullEnv)

            const db = global.indexerDatabase
            assert.strictEqual(db.user, 'root')
            assert.strictEqual(db.pass, 'password')
            assert.strictEqual(db.dbName, 'XChain_BTC_Regtest_Indexer')
        })
    })
})
