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

// Integration tests for bootstrap error scenarios.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')

// Inject mock mariadb before requiring anything that depends on it
require('../fixtures/mockMariadb')

const CryptoNetworks = require('../../../src/CryptoNetworks')

describe('Error Propagation: Setup Errors', function () {

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
            indexerConnector: global.indexerConnector,
            indexerDatabase: global.indexerDatabase,
            regtestMinerConnector: global.regtestMinerConnector,
        }
    })

    afterEach(function () {
        Object.assign(global, savedGlobals)
        sinon.restore()
    })

    // Replicate the service ping sequence from initialCheck.test.js lines 160-195
    async function runPingSequence() {
        try {
            let pingNode = await nodeConnector.getNetworkInfo()
            if (!pingNode) {
                throw new Error("Can't connect to the node")
            }
        } catch (err) {
            throw new Error('There was an error trying to connect to the node')
        }

        let pingUtxoTracker = await utxoTrackerConnector.ping()
        if (!pingUtxoTracker) {
            throw new Error("Can't connect to the XChain Utxo Tracker module")
        }

        let pingEncoder = await encoderConnector.ping()
        if (!pingEncoder) {
            throw new Error("Can't connect to the XChain Encoder module")
        }

        let pingIndexer = await indexerConnector.ping()
        if (!pingIndexer) {
            throw new Error("Can't connect to the XChain Indexer module")
        }

        let pingIndexerDatabase = await indexerDatabase.ping()
        if (!pingIndexerDatabase) {
            throw new Error("Can't connect to the XChain Indexer Database")
        }

        let pingRegtestMiner = await regtestMinerConnector.ping()
        if (!pingRegtestMiner) {
            throw new Error("Can't connect to the XChain Regtest Miner module")
        } else {
            await regtestMinerConnector.setMiningTime(1000, 1000)
        }
    }

    describe('Scenario 3.1.3: Service ping failures', function () {

        it('throws when node ping fails', async function () {
            global.nodeConnector = {
                getNetworkInfo: async () => { throw new Error('ECONNREFUSED') }
            }
            global.utxoTrackerConnector = { ping: async () => true }
            global.encoderConnector = { ping: async () => true }
            global.indexerConnector = { ping: async () => true }
            global.indexerDatabase = { ping: async () => true }
            global.regtestMinerConnector = { ping: async () => true, setMiningTime: async () => true }

            await assert.rejects(
                () => runPingSequence(),
                { message: 'There was an error trying to connect to the node' }
            )
        })

        it('throws when utxo tracker ping returns false', async function () {
            global.nodeConnector = { getNetworkInfo: async () => ({ version: 1 }) }
            global.utxoTrackerConnector = { ping: async () => false }
            global.encoderConnector = { ping: async () => true }
            global.indexerConnector = { ping: async () => true }
            global.indexerDatabase = { ping: async () => true }
            global.regtestMinerConnector = { ping: async () => true, setMiningTime: async () => true }

            await assert.rejects(
                () => runPingSequence(),
                { message: "Can't connect to the XChain Utxo Tracker module" }
            )
        })

        it('throws when encoder ping returns false', async function () {
            global.nodeConnector = { getNetworkInfo: async () => ({ version: 1 }) }
            global.utxoTrackerConnector = { ping: async () => true }
            global.encoderConnector = { ping: async () => false }
            global.indexerConnector = { ping: async () => true }
            global.indexerDatabase = { ping: async () => true }
            global.regtestMinerConnector = { ping: async () => true, setMiningTime: async () => true }

            await assert.rejects(
                () => runPingSequence(),
                { message: "Can't connect to the XChain Encoder module" }
            )
        })

        it('throws when indexer ping returns false', async function () {
            global.nodeConnector = { getNetworkInfo: async () => ({ version: 1 }) }
            global.utxoTrackerConnector = { ping: async () => true }
            global.encoderConnector = { ping: async () => true }
            global.indexerConnector = { ping: async () => false }
            global.indexerDatabase = { ping: async () => true }
            global.regtestMinerConnector = { ping: async () => true, setMiningTime: async () => true }

            await assert.rejects(
                () => runPingSequence(),
                { message: "Can't connect to the XChain Indexer module" }
            )
        })

        it('throws when indexer DB ping returns false', async function () {
            global.nodeConnector = { getNetworkInfo: async () => ({ version: 1 }) }
            global.utxoTrackerConnector = { ping: async () => true }
            global.encoderConnector = { ping: async () => true }
            global.indexerConnector = { ping: async () => true }
            global.indexerDatabase = { ping: async () => false }
            global.regtestMinerConnector = { ping: async () => true, setMiningTime: async () => true }

            await assert.rejects(
                () => runPingSequence(),
                { message: "Can't connect to the XChain Indexer Database" }
            )
        })

        it('throws when regtest miner ping returns false', async function () {
            global.nodeConnector = { getNetworkInfo: async () => ({ version: 1 }) }
            global.utxoTrackerConnector = { ping: async () => true }
            global.encoderConnector = { ping: async () => true }
            global.indexerConnector = { ping: async () => true }
            global.indexerDatabase = { ping: async () => true }
            global.regtestMinerConnector = { ping: async () => false, setMiningTime: async () => true }

            await assert.rejects(
                () => runPingSequence(),
                { message: "Can't connect to the XChain Regtest Miner module" }
            )
        })

        it('calls setMiningTime(1000, 1000) on successful miner ping', async function () {
            const setMiningTimeStub = sinon.stub().resolves(true)
            global.nodeConnector = { getNetworkInfo: async () => ({ version: 1 }) }
            global.utxoTrackerConnector = { ping: async () => true }
            global.encoderConnector = { ping: async () => true }
            global.indexerConnector = { ping: async () => true }
            global.indexerDatabase = { ping: async () => true }
            global.regtestMinerConnector = { ping: async () => true, setMiningTime: setMiningTimeStub }

            await runPingSequence()

            assert(setMiningTimeStub.calledOnce)
            assert.deepStrictEqual(setMiningTimeStub.firstCall.args, [1000, 1000])
        })
    })

    describe('Scenario 3.7.5: Gas token bootstrap failure', function () {

        it('throws when gas token issue fails', async function () {
            // Replicate gas token check from initialCheck.test.js lines 198-215
            async function runGasBootstrap(db, cryptoHelper, issueHelper) {
                const GAS_TICK = 'XCHAIN'
                const gasTokenExists = await db.checkIssue({ tick: GAS_TICK, status: 'valid' })
                if (!gasTokenExists) {
                    let gasAddressInfo = await cryptoHelper.getNewFundedAddress('GAS.TOKEN', COIN, NETWORK, null, 'legacy', 0, 1)
                    await issueHelper.sendIssueV0(gasAddressInfo, GAS_TICK, 1000000000, 1000000, 0, 'XChain GAS Token', 1000000)
                }
            }

            global.COIN = 'bitcoin'
            global.NETWORK = 'regtest'

            const mockDb = { checkIssue: async () => null }
            const mockCrypto = {
                getNewFundedAddress: async () => ({ address: 'gasAddr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) })
            }
            const mockIssue = {
                sendIssueV0: async () => { throw new Error('Encoder unreachable during gas bootstrap') }
            }

            await assert.rejects(
                () => runGasBootstrap(mockDb, mockCrypto, mockIssue),
                /Encoder unreachable during gas bootstrap/
            )
        })

        it('skips gas token creation when XCHAIN already exists', async function () {
            async function runGasBootstrap(db, issueHelper) {
                const GAS_TICK = 'XCHAIN'
                const gasTokenExists = await db.checkIssue({ tick: GAS_TICK, status: 'valid' })
                if (!gasTokenExists) {
                    await issueHelper.sendIssueV0()
                }
                return gasTokenExists
            }

            const mockDb = { checkIssue: async () => ({ tick: 'XCHAIN', status: 'valid' }) }
            const sendIssueV0 = sinon.stub()

            const result = await runGasBootstrap(mockDb, { sendIssueV0 })

            assert(result, 'gas token should exist')
            assert(sendIssueV0.notCalled, 'sendIssueV0 should not be called when gas exists')
        })
    })
})
