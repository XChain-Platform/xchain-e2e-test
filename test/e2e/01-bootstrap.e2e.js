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
const cryptoHelper = require('../cryptoHelper')

// MANUAL VERIFICATION REQUIRED:
// E2E-INIT-002 (hub-only boot): Run `npm test` with only COIN/NETWORK/HUB_URL/HUB_PORT set
// E2E-INIT-004 (missing service): Stop a Docker container, run `npm test`, verify exit code 1

describe('E2E: Suite Bootstrap & Initialization', () => {
    describe('E2E-INIT-001: Global state after bootstrap', () => {
        it('should have COIN set to a valid coin type', () => {
            assert(global.COIN, 'COIN global should be set')
            const validCoins = ['bitcoin', 'litecoin', 'dogecoin']
            assert(validCoins.includes(COIN), 'COIN should be bitcoin, litecoin, or dogecoin, got: ' + COIN)
        })

        it('should have NETWORK set to a valid network', () => {
            assert(global.NETWORK, 'NETWORK global should be set')
            const validNetworks = ['mainnet', 'testnet', 'regtest']
            assert(validNetworks.includes(NETWORK), 'NETWORK should be mainnet, testnet, or regtest, got: ' + NETWORK)
        })

        it('should have COIN_CODE matching the COIN value', () => {
            assert(global.COIN_CODE, 'COIN_CODE global should be set')
            const expectedMap = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' }
            assert.strictEqual(COIN_CODE, expectedMap[COIN], 'COIN_CODE should match COIN')
        })

        it('should have NETWORK_OBJECT with required bitcoinjs-lib fields', () => {
            assert(global.NETWORK_OBJECT, 'NETWORK_OBJECT global should be set')
            assert(NETWORK_OBJECT.pubKeyHash !== undefined, 'NETWORK_OBJECT should have pubKeyHash')
            assert(NETWORK_OBJECT.scriptHash !== undefined, 'NETWORK_OBJECT should have scriptHash')
            assert(NETWORK_OBJECT.wif !== undefined, 'NETWORK_OBJECT should have wif')
            assert(NETWORK_OBJECT.bip32, 'NETWORK_OBJECT should have bip32')
            assert(NETWORK_OBJECT.bip32.public !== undefined, 'NETWORK_OBJECT.bip32 should have public')
            assert(NETWORK_OBJECT.bip32.private !== undefined, 'NETWORK_OBJECT.bip32 should have private')
            assert.strictEqual(NETWORK_OBJECT.dustThreshold, 546, 'dustThreshold should be 546')
        })

        it('should have all seven connectors instantiated with valid URLs', () => {
            assert(global.nodeConnector, 'nodeConnector should be initialized')
            assert(typeof nodeConnector.url === 'string', 'nodeConnector.url should be a string')
            assert(nodeConnector.url.startsWith('http'), 'nodeConnector.url should start with http')

            assert(global.utxoTrackerConnector, 'utxoTrackerConnector should be initialized')
            assert(typeof utxoTrackerConnector.url === 'string', 'utxoTrackerConnector.url should be a string')

            assert(global.encoderConnector, 'encoderConnector should be initialized')
            assert(typeof encoderConnector.url === 'string', 'encoderConnector.url should be a string')

            assert(global.indexerConnector, 'indexerConnector should be initialized')
            assert(typeof indexerConnector.url === 'string', 'indexerConnector.url should be a string')

            assert(global.indexerDatabase, 'indexerDatabase should be initialized')
            assert(indexerDatabase.host, 'indexerDatabase should have a host')
            assert(indexerDatabase.dbName, 'indexerDatabase should have a dbName')

            assert(global.regtestMinerConnector, 'regtestMinerConnector should be initialized')
            assert(typeof regtestMinerConnector.url === 'string', 'regtestMinerConnector.url should be a string')
        })

        it('should have a live connection pool for the indexer database', async () => {
            const result = await indexerDatabase.ping()
            assert(result, 'indexerDatabase.ping() should return truthy after bootstrap')
        })

        it('should have all services still reachable after bootstrap completes', async () => {
            const networkInfo = await nodeConnector.getNetworkInfo()
            assert(networkInfo, 'Blockchain node should respond to getNetworkInfo')

            const pingUtxo = await utxoTrackerConnector.ping()
            assert(pingUtxo, 'UTXO tracker should respond to ping')

            const pingEncoder = await encoderConnector.ping()
            assert(pingEncoder, 'Encoder should respond to ping')

            const pingIndexer = await indexerConnector.ping()
            assert(pingIndexer, 'Indexer should respond to ping')

            const pingMiner = await regtestMinerConnector.ping()
            assert(pingMiner, 'Regtest miner should respond to ping')
        })
    })

    describe('E2E-INIT-003: GAS token existence after bootstrap', () => {
        it('should have XCHAIN token in the indexer database with status valid', async () => {
            const gasToken = await indexerDatabase.checkIssue({ tick: 'XCHAIN', status: 'valid' })
            assert(gasToken, 'GAS token (XCHAIN) should exist with status valid')
            assert.strictEqual(gasToken.tick, 'XCHAIN', 'GAS token tick should be XCHAIN')
            assert(Number(gasToken.max_supply) > 0, 'GAS token max_supply should be > 0')
            assert(Number(gasToken.mint_supply) > 0, 'GAS token mint_supply should be > 0')
        })

        it('should have a credit record for the XCHAIN initial mint supply', async () => {
            const credit = await indexerDatabase.checkCredit({ tick: 'XCHAIN' })
            assert(credit, 'XCHAIN credit record should exist')
            assert(Number(credit.amount) > 0, 'XCHAIN credit amount should be > 0')
        })
    })

    describe('E2E-INIT-005: Bootstrap idempotency', () => {
        it('should return the same XCHAIN record on repeated checkIssue calls', async () => {
            const first = await indexerDatabase.checkIssue({ tick: 'XCHAIN', status: 'valid' })
            const second = await indexerDatabase.checkIssue({ tick: 'XCHAIN', status: 'valid' })
            assert(first, 'First checkIssue call should return a row')
            assert(second, 'Second checkIssue call should return a row')
            assert.strictEqual(first.tx_hash, second.tx_hash, 'Both calls should return the same tx_hash')
        })

        it('should generate unique wallet addresses for different labels', async () => {
            const addr1 = await cryptoHelper.getNewFundedAddress('E2E.BOOT.UNIQUE1', COIN, NETWORK, null, 'legacy', 0, 1)
            const addr2 = await cryptoHelper.getNewFundedAddress('E2E.BOOT.UNIQUE2', COIN, NETWORK, null, 'legacy', 0, 1)
            assert(addr1.address, 'First address should be truthy')
            assert(addr2.address, 'Second address should be truthy')
            assert(addr1.address !== addr2.address, 'Different wallet labels should produce different addresses')
            assert(global.wallets['E2E.BOOT.UNIQUE1'], 'First wallet should be cached in global.wallets')
            assert(global.wallets['E2E.BOOT.UNIQUE2'], 'Second wallet should be cached in global.wallets')
        })
    })
})
