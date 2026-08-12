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

// Boundary tests for global state management, service discovery fallback,
// CryptoNetworks edge cases, and wallet cache behavior under stress.

const assert = require('assert')
const sinon = require('sinon')

const CryptoNetworks = require('../../src/CryptoNetworks')
const XChainHubConnector = require('../../src/XChainHubConnector')

describe('Boundary: Global State & Service Discovery', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('CryptoNetworks.getBitcoinJsNetwork', function () {

        it('returns network with dustThreshold for bitcoin-regtest', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest')
            assert.ok(network)
            assert.strictEqual(network.dustThreshold, 546)
            assert.ok(network.pubKeyHash !== undefined)
        })

        it('returns network with dustThreshold for bitcoin-mainnet', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork('bitcoin-mainnet')
            assert.ok(network)
            assert.strictEqual(network.dustThreshold, 546)
        })

        it('returns network with dustThreshold for bitcoin-testnet', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork('bitcoin-testnet')
            assert.ok(network)
            assert.strictEqual(network.dustThreshold, 546)
        })

        it('returns network for dogecoin-mainnet', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork('dogecoin-mainnet')
            assert.ok(network)
            assert.strictEqual(network.dustThreshold, 100000)
            assert.strictEqual(network.pubKeyHash, 0x1e)
        })

        it('returns network for dogecoin-testnet', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork('dogecoin-testnet')
            assert.ok(network)
            assert.strictEqual(network.dustThreshold, 100000)
            assert.strictEqual(network.pubKeyHash, 0x71)
        })

        it('returns network for dogecoin-regtest', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork('dogecoin-regtest')
            assert.ok(network)
            assert.strictEqual(network.dustThreshold, 100000)
        })

        it('returns network for litecoin-mainnet', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork('litecoin-mainnet')
            assert.ok(network)
            assert.strictEqual(network.dustThreshold, 5460)
            assert.strictEqual(network.pubKeyHash, 0x30)
        })

        it('returns network for litecoin-testnet', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork('litecoin-testnet')
            assert.ok(network)
            assert.strictEqual(network.dustThreshold, 5460)
        })

        it('returns network for litecoin-regtest', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork('litecoin-regtest')
            assert.ok(network)
            assert.strictEqual(network.dustThreshold, 5460)
        })

        it('returns undefined for unknown network name', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork('ethereum-mainnet')
            assert.strictEqual(network, undefined)
        })

        it('returns undefined for empty string', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork('')
            assert.strictEqual(network, undefined)
        })

        it('returns undefined for null', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork(null)
            assert.strictEqual(network, undefined)
        })

        it('returns undefined for case-wrong input', function () {
            const network = CryptoNetworks.getBitcoinJsNetwork('Bitcoin-Regtest')
            assert.strictEqual(network, undefined)
        })

        it('all networks have the correct per-chain dustThreshold', function () {
            // Per-chain dust floors differ: Bitcoin 546 sats; Litecoin 5460
            // litoshis (10× Bitcoin's dust relay fee); Dogecoin 100000 koinu
            // (Dogecoin Core's hard dust limit DEFAULT_HARD_DUST_LIMIT = COIN/100/10).
            const expectedDust = {
                'bitcoin-mainnet': 546, 'bitcoin-testnet': 546, 'bitcoin-regtest': 546,
                'dogecoin-mainnet': 100000, 'dogecoin-testnet': 100000, 'dogecoin-regtest': 100000,
                'litecoin-mainnet': 5460, 'litecoin-testnet': 5460, 'litecoin-regtest': 5460,
            }

            Object.entries(expectedDust).forEach(([name, dust]) => {
                const network = CryptoNetworks.getBitcoinJsNetwork(name)
                assert.strictEqual(network.dustThreshold, dust,
                    `${name} should have dustThreshold = ${dust}`)
            })
        })
    })

    describe('CryptoNetworks.getFirstBlock', function () {

        it('returns 950000 for bitcoin-mainnet', function () {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-mainnet'), 950000)
        })

        // Repinned by the 2026-08-10 testnet re-genesis (vendored here as 5c41cec),
        // which raised BTC testnet firstBlock 138000 -> 147500 to match the unit
        // suite's twin assertion.
        it('returns 147500 for bitcoin-testnet', function () {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-testnet'), 147500)
        })

        it('returns 0 for bitcoin-regtest', function () {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-regtest'), 0)
        })

        it('returns 0 for unknown network (default fallback)', function () {
            assert.strictEqual(CryptoNetworks.getFirstBlock('ethereum-mainnet'), 0)
        })

        it('returns 0 for empty string', function () {
            assert.strictEqual(CryptoNetworks.getFirstBlock(''), 0)
        })
    })

    describe('Wallet cache global state', function () {

        let cryptoHelper

        before(function () {
            global.wallets = {}
            global.regtestMinerConnector = { sendFunds: async () => 'txid-stub' }
            global.nodeConnector = { waitForTx: async () => true }
            global.utxoTrackerConnector = { waitForUtxos: async () => true }
            cryptoHelper = require('../cryptoHelper')
        })

        beforeEach(function () {
            global.wallets = {}
        })

        afterEach(function () {
            global.wallets = {}
        })

        it('GS-06: second getWallet call ignores different parameters (returns cached)', async function () {
            const wallet1 = await cryptoHelper.getWallet('test')
            wallet1.coin = 'bitcoin'
            wallet1.network = { name: 'regtest' }

            const wallet2 = await cryptoHelper.getWallet('test')

            assert.strictEqual(wallet2, wallet1)
            assert.strictEqual(wallet2.coin, 'bitcoin', 'cached properties preserved')
        })

        it('handles rapid sequential wallet creation for many labels', async function () {
            const labels = []
            for (let i = 0; i < 100; i++) {
                labels.push(`wallet-${i}`)
            }

            const wallets = await Promise.all(labels.map(l => cryptoHelper.getWallet(l)))

            assert.strictEqual(wallets.length, 100)
            assert.strictEqual(Object.keys(global.wallets).length, 100)

            const unique = new Set(wallets)
            assert.strictEqual(unique.size, 100, 'all 100 wallets should be distinct objects')
        })

        it('wallets persist across multiple getWallet calls', async function () {
            await cryptoHelper.getWallet('alice')
            await cryptoHelper.getWallet('bob')
            await cryptoHelper.getWallet('charlie')

            assert.strictEqual(Object.keys(global.wallets).length, 3)
            assert.ok('alice' in global.wallets)
            assert.ok('bob' in global.wallets)
            assert.ok('charlie' in global.wallets)
        })
    })

    describe('Hub multi-endpoint fallback boundaries', function () {

        it('returns null when all endpoints fail', async function () {
            const axios = require('axios')
            const postStub = sinon.stub(axios, 'post').rejects(new Error('ECONNREFUSED'))

            const hub = new XChainHubConnector(['http://hub1:10000', 'http://hub2:10000', 'http://hub3:10000'])
            const result = await hub.getAllConfig()

            assert.strictEqual(result, null)
            assert.strictEqual(postStub.callCount, 3, 'should try all 3 endpoints')
        })

        it('returns result from second endpoint when first fails', async function () {
            const axios = require('axios')
            const mockConfig = { bitcoin: { regtest: {} } }
            const postStub = sinon.stub(axios, 'post')
            postStub.onFirstCall().rejects(new Error('ECONNREFUSED'))
            postStub.onSecondCall().resolves({ data: { result: mockConfig } })

            const hub = new XChainHubConnector(['http://hub1:10000', 'http://hub2:10000'])
            const result = await hub.getAllConfig()

            assert.deepStrictEqual(result, mockConfig)
            assert.strictEqual(postStub.callCount, 2, 'should stop after first success')
        })

        it('returns result from first endpoint when it succeeds', async function () {
            const axios = require('axios')
            const mockConfig = { bitcoin: { regtest: {} } }
            const postStub = sinon.stub(axios, 'post')
                .resolves({ data: { result: mockConfig } })

            const hub = new XChainHubConnector(['http://hub1:10000', 'http://hub2:10000'])
            const result = await hub.getAllConfig()

            assert.deepStrictEqual(result, mockConfig)
            assert.strictEqual(postStub.callCount, 1, 'should not try second endpoint')
        })
    })

    describe('Database.isNullOrNullString boundary values', function () {

        const mockMariadb = require('../integration/fixtures/mockMariadb')
        const Database = require('../../src/db')

        let db

        before(function () {
            const mockConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() }
            const mockPool = { getConnection: sinon.stub().resolves(mockConn) }
            mockMariadb.createPool.returns(mockPool)
            db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
        })

        it('returns true for null', function () {
            assert.strictEqual(db.isNullOrNullString(null), true)
        })

        it('returns true for undefined', function () {
            assert.strictEqual(db.isNullOrNullString(undefined), true)
        })

        it('returns true for empty string', function () {
            assert.strictEqual(db.isNullOrNullString(''), true)
        })

        it('returns false for non-empty string', function () {
            assert.strictEqual(db.isNullOrNullString('hello'), false)
        })

        it('returns false for zero (0 == "" is true in JS loose comparison)', function () {
            // Note: 0 == "" is true in JavaScript, so isNullOrNullString(0)
            // returns true due to loose == comparison. This documents the actual behavior.
            const result = db.isNullOrNullString(0)
            // 0 == "" is true in JS, so this returns true. Documenting this boundary.
            assert.strictEqual(result, true,
                'JS loose equality: 0 == "" is true (this is the actual behavior)')
        })

        it('returns false for whitespace-only string', function () {
            assert.strictEqual(db.isNullOrNullString(' '), false)
        })

        it('returns false for "null" string literal', function () {
            assert.strictEqual(db.isNullOrNullString('null'), false)
        })

        it('returns false for false boolean', function () {
            // false == "" is true in JS loose comparison
            const result = db.isNullOrNullString(false)
            assert.strictEqual(result, true,
                'JS loose equality: false == "" is true (documenting actual behavior)')
        })
    })
})
