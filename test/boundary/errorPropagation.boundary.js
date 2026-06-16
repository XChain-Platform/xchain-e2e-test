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

// Boundary tests for error propagation through the test suite's orchestration layers:
// cryptoHelper.getNewFundedAddress, transactionHelper, and the Database waitFor*/check* chain.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')

// Set up required globals
global.wallets = {}
global.NETWORK_OBJECT = { ...bitcoin.networks.regtest, dustThreshold: 546 }
global.regtestMinerConnector = { sendFunds: async () => 'txid-stub' }
global.nodeConnector = {
    waitForTx: async () => true,
    broadcastTx: async () => 'txhash-stub',
    getFeePerKilobyte: async () => 0.001,
    getTransactionHex: async () => ''
}
global.utxoTrackerConnector = {
    waitForUtxos: async () => true,
    getUtxosFromAddress: async () => ({ utxos: [] })
}
global.encoderConnector = { createTx: async () => {} }

const cryptoHelper = require('../cryptoHelper')
const transactionHelper = require('../transactionHelper')

// Inject mock mariadb
const mockMariadb = require('../integration/fixtures/mockMariadb')
const Database = require('../../src/db')

function makeMockConnection(queryResult) {
    return {
        query: sinon.stub().resolves(queryResult !== undefined ? queryResult : []),
        release: sinon.stub().resolves(),
    }
}

function createDb() {
    const mockConn = makeMockConnection()
    const mockPool = { getConnection: sinon.stub().resolves(mockConn) }
    mockMariadb.createPool.returns(mockPool)
    const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
    db.sleep = sinon.stub().resolves()
    return { db, mockConn, mockPool }
}

describe('Boundary — Error Propagation', function () {

    const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

    beforeEach(function () {
        global.wallets = {}
    })

    afterEach(function () {
        sinon.restore()
        global.wallets = {}
        mockMariadb.createPool.resetHistory()
    })

    // ── EP-01: sendFunds returns null ───────────────────────────

    describe('EP-01: regtestMinerConnector.sendFunds returns null', function () {

        it('getNewFundedAddress throws when sendFunds returns null (no txId)', async function () {
            sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves(null)
            sinon.stub(global.nodeConnector, 'waitForTx').resolves(false)
            sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(true)

            await assert.rejects(
                () => cryptoHelper.getNewFundedAddress('test', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0),
                /didn't appear in the blockchain/
            )
        })
    })

    // ── EP-02: sendFunds throws ─────────────────────────────────

    describe('EP-02: regtestMinerConnector.sendFunds throws', function () {

        it('getNewFundedAddress propagates the error', async function () {
            sinon.stub(global.regtestMinerConnector, 'sendFunds').rejects(new Error('Miner unreachable'))

            await assert.rejects(
                () => cryptoHelper.getNewFundedAddress('test', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0),
                /Miner unreachable/
            )
        })
    })

    // ── EP-03: nodeConnector.waitForTx returns false ────────────

    describe('EP-03: waitForTx returns false', function () {

        it('getNewFundedAddress throws descriptive error', async function () {
            sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves('txid-abc')
            sinon.stub(global.nodeConnector, 'waitForTx').resolves(false)
            sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(true)

            await assert.rejects(
                () => cryptoHelper.getNewFundedAddress('test', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0),
                /didn't appear in the blockchain/
            )
        })
    })

    // ── EP-04: nodeConnector.waitForTx throws ───────────────────

    describe('EP-04: waitForTx throws an error', function () {

        it('getNewFundedAddress wraps and re-throws', async function () {
            sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves('txid-abc')
            sinon.stub(global.nodeConnector, 'waitForTx').rejects(new Error('RPC timeout'))
            sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(true)

            await assert.rejects(
                () => cryptoHelper.getNewFundedAddress('test', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0),
                /didn't appear in the blockchain/
            )
        })
    })

    // ── EP-05: utxoTrackerConnector.waitForUtxos returns false ──

    describe('EP-05: waitForUtxos returns false', function () {

        it('getNewFundedAddress throws UTXO tracking error', async function () {
            sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves('txid-abc')
            sinon.stub(global.nodeConnector, 'waitForTx').resolves(true)
            sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(false)

            await assert.rejects(
                () => cryptoHelper.getNewFundedAddress('test', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0),
                /utxo tracker couldn't parse/
            )
        })
    })

    // ── EP-06: utxoTrackerConnector.waitForUtxos throws ─────────

    describe('EP-06: waitForUtxos throws', function () {

        it('getNewFundedAddress wraps and re-throws', async function () {
            sinon.stub(global.regtestMinerConnector, 'sendFunds').resolves('txid-abc')
            sinon.stub(global.nodeConnector, 'waitForTx').resolves(true)
            sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').rejects(new Error('tracker down'))

            await assert.rejects(
                () => cryptoHelper.getNewFundedAddress('test', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0),
                /utxo tracker couldn't parse/
            )
        })
    })

    // ── EP-07: Database check* returns null on SQL error ────────

    describe('EP-07: Database check* SQL errors return null', function () {

        it('checkIssue returns null on query error', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('Table does not exist'))

            const result = await db.checkIssue({ tick: 'TOK' })
            assert.strictEqual(result, null)
        })

        it('checkSend returns null on query error', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('Unknown column'))

            const result = await db.checkSend({ source: 'addr1' })
            assert.strictEqual(result, null)
        })

        it('checkCredit returns null on query error', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('Deadlock detected'))

            const result = await db.checkCredit({ tick: 'TOK' })
            assert.strictEqual(result, null)
        })

        it('checkDebit returns null on query error', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('Lock timeout'))

            const result = await db.checkDebit({ tick: 'TOK' })
            assert.strictEqual(result, null)
        })
    })

    // ── EP-08: waitFor* returns null when check* always returns null ──

    describe('EP-08: waitFor* times out when check* never finds a row', function () {

        it('waitForIssue returns null after timeout', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            const result = await db.waitForIssue({ tick: 'NONEXISTENT' }, 100)
            assert.strictEqual(result, null)
        })

        it('waitForSend returns null after timeout', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            const result = await db.waitForSend({ source: 'nowhere' }, 100)
            assert.strictEqual(result, null)
        })

        it('waitForCredit returns null after timeout', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            const result = await db.waitForCredit({ tick: 'NONEXISTENT' }, 100)
            assert.strictEqual(result, null)
        })

        it('waitForDebit returns null after timeout', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            const result = await db.waitForDebit({ tick: 'NONEXISTENT' }, 100)
            assert.strictEqual(result, null)
        })
    })

    // ── EP-09: waitFor* recovers from intermittent errors ───────

    describe('EP-09: waitFor* continues polling after intermittent check* errors', function () {

        it('waitForIssue succeeds after transient DB errors', async function () {
            const { db, mockConn } = createDb()
            const mockRow = { tick: 'TOK', status: 'valid' }

            mockConn.query.onFirstCall().rejects(new Error('transient error'))
            mockConn.query.onSecondCall().rejects(new Error('transient error'))
            mockConn.query.onThirdCall().resolves([mockRow])

            const result = await db.waitForIssue({ tick: 'TOK' }, 30000)

            assert.deepStrictEqual(result, mockRow)
            assert(db.sleep.callCount >= 2, 'should sleep between retries')
        })

        it('waitForSend succeeds after transient errors', async function () {
            const { db, mockConn } = createDb()
            const mockRow = { source: 'addr1', tick: 'TOK' }

            mockConn.query.onFirstCall().rejects(new Error('timeout'))
            mockConn.query.onSecondCall().resolves([mockRow])

            const result = await db.waitForSend({ source: 'addr1' }, 30000)

            assert.deepStrictEqual(result, mockRow)
        })
    })

    // ── EP-10: Combined — error + zero timeout ──────────────────

    describe('EP-10: Error conditions combined with zero timeout', function () {

        it('waitForIssue with timeMax=0 and failing query returns null without entering loop', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('DB down'))

            const result = await db.waitForIssue({ tick: 'TOK' }, 0)

            assert.strictEqual(result, null)
            assert.strictEqual(mockConn.query.callCount, 0, 'loop body never entered with timeMax=0')
        })
    })

    // ── EP-11: getNewFundedAddress error does not corrupt wallet cache ──

    describe('EP-11: Failed funding does not corrupt wallet cache', function () {

        it('wallet is created in cache even when funding fails', async function () {
            sinon.stub(global.regtestMinerConnector, 'sendFunds').rejects(new Error('Miner down'))

            try {
                await cryptoHelper.getNewFundedAddress('failed-fund', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0)
            } catch (e) {
                // Expected to fail
            }

            // Wallet should exist in cache since getNewAddress succeeded before funding
            assert.ok('failed-fund' in global.wallets, 'wallet should be cached even after funding failure')
            const wallet = global.wallets['failed-fund']
            assert.strictEqual(wallet.addresses.length, 1, 'address should be recorded')
        })

        it('subsequent call with same label reuses cached wallet after prior failure', async function () {
            sinon.stub(global.regtestMinerConnector, 'sendFunds')
                .onFirstCall().rejects(new Error('Miner down'))
                .onSecondCall().resolves('txid-ok')
            sinon.stub(global.nodeConnector, 'waitForTx').resolves(true)
            sinon.stub(global.utxoTrackerConnector, 'waitForUtxos').resolves(true)

            try {
                await cryptoHelper.getNewFundedAddress('retry-fund', 'bitcoin', 'regtest', MNEMONIC, 'legacy', 0, 1.0)
            } catch (e) {
                // Expected first failure
            }

            // Second call with same label — wallet is cached, mnemonic reused
            const result = await cryptoHelper.getNewFundedAddress('retry-fund', 'bitcoin', 'regtest', null, 'legacy', 1, 1.0)

            assert.ok(result.address, 'second call should succeed')
            assert.strictEqual(global.wallets['retry-fund'].addresses.length, 2,
                'both addresses should be in cache')
        })
    })
})
