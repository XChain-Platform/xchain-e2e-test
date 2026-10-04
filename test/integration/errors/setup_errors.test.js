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
const net = require('net')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')

require('../fixtures/mockMariadb')

const CryptoNetworks = require('../../../src/crypto_networks')
const RegtestMinerConnector = require('../../../src/regtest_miner_connector')

let savedGlobals

function saveGlobals() {
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
    }
}

function restoreGlobals() {
    Object.assign(global, savedGlobals)
    sinon.restore()
}

// Mirror the phase('service-pings') body of initial_check.test.js: same order, calls and messages.
// (Only the console.log in the node catch is dropped; the offline suite has no use for it.)
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

    let pingDecoder = await decoderConnector.ping()
    if (!pingDecoder) {
        throw new Error("Can't connect to the XChain Decoder module")
    }

    let pingIndexer = await indexerConnector.ping()
    if (!pingIndexer) {
        throw new Error("Can't connect to the XChain Indexer module")
    }

    let pingExplorer = await explorerConnector.ping()
    if (!pingExplorer) {
        throw new Error("Can't connect to the XChain Explorer module")
    }

    let pingIndexerDatabase = await indexerDatabase.ping()
    if (!pingIndexerDatabase) {
        throw new Error("Can't connect to the XChain Indexer Database")
    }

    let pingRegtestMiner = await regtestMinerConnector.waitForReady()
    if (!pingRegtestMiner) {
        throw new Error("Can't connect to the XChain Regtest Miner module (not ready after wait)")
    } else {
        await regtestMinerConnector.setMiningTime(1000, 1000)
    }
}

// Install healthy connector mocks on the globals, then apply per-test overrides.
function installConnectors(overrides = {}) {
    Object.assign(global, {
        nodeConnector: { getNetworkInfo: async () => ({ version: 1 }) },
        utxoTrackerConnector: { ping: async () => true },
        encoderConnector: { ping: async () => true },
        decoderConnector: { ping: async () => true },
        indexerConnector: { ping: async () => true },
        explorerConnector: { ping: async () => true },
        indexerDatabase: { ping: async () => true },
        // ping() is false on purpose: the bootstrap gates on waitForReady, never a single ping.
        regtestMinerConnector: { ping: async () => false, waitForReady: async () => true, setMiningTime: async () => true },
    }, overrides)
}

// Resolve a local port with no listener, so a real connector's request is refused.
function deadPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address()
            server.close(() => resolve(port))
        })
    })
}

function registerPingFailuresOne() {
    describe('Scenario 3.1.3: Service ping failures', function () {

        it('throws when node ping fails', async function () {
            installConnectors({
                nodeConnector: { getNetworkInfo: async () => { throw new Error('ECONNREFUSED') } }
            })

            await assert.rejects(
                () => runPingSequence(),
                { message: 'There was an error trying to connect to the node' }
            )
        })

        it('throws when utxo tracker ping returns false', async function () {
            installConnectors({ utxoTrackerConnector: { ping: async () => false } })

            await assert.rejects(
                () => runPingSequence(),
                { message: "Can't connect to the XChain Utxo Tracker module" }
            )
        })

        it('throws when encoder ping returns false', async function () {
            installConnectors({ encoderConnector: { ping: async () => false } })

            await assert.rejects(
                () => runPingSequence(),
                { message: "Can't connect to the XChain Encoder module" }
            )
        })

        it('throws when decoder ping returns false', async function () {
            installConnectors({ decoderConnector: { ping: async () => false } })

            await assert.rejects(
                () => runPingSequence(),
                { message: "Can't connect to the XChain Decoder module" }
            )
        })
    })
}

function registerPingFailuresTwo() {
    describe('Scenario 3.1.3: Service ping failures', function () {
        it('throws when indexer ping returns false', async function () {
            installConnectors({ indexerConnector: { ping: async () => false } })

            await assert.rejects(
                () => runPingSequence(),
                { message: "Can't connect to the XChain Indexer module" }
            )
        })

        it('throws when explorer ping returns false', async function () {
            installConnectors({ explorerConnector: { ping: async () => false } })

            await assert.rejects(
                () => runPingSequence(),
                { message: "Can't connect to the XChain Explorer module" }
            )
        })

        it('throws when indexer DB ping returns false', async function () {
            installConnectors({ indexerDatabase: { ping: async () => false } })

            await assert.rejects(
                () => runPingSequence(),
                { message: "Can't connect to the XChain Indexer Database" }
            )
        })

        it('throws when the regtest miner is not ready after the wait', async function () {
            installConnectors({
                regtestMinerConnector: { ping: async () => true, waitForReady: async () => false, setMiningTime: async () => true }
            })

            await assert.rejects(
                () => runPingSequence(),
                { message: "Can't connect to the XChain Regtest Miner module (not ready after wait)" }
            )
        })
    })
}

function registerMinerReadiness() {
    describe('Scenario 3.1.3: Regtest miner readiness gate', function () {
        it('pings every service in bootstrap order', async function () {
            const calls = []
            const named = (name) => ({ ping: async () => { calls.push(name); return true } })
            installConnectors({
                nodeConnector: { getNetworkInfo: async () => { calls.push('node'); return { version: 1 } } },
                utxoTrackerConnector: named('utxo'), encoderConnector: named('encoder'),
                decoderConnector: named('decoder'), indexerConnector: named('indexer'),
                explorerConnector: named('explorer'), indexerDatabase: named('db'),
                regtestMinerConnector: { waitForReady: async () => { calls.push('miner'); return true }, setMiningTime: async () => true }
            })

            await runPingSequence()

            assert.deepStrictEqual(calls, ['node', 'utxo', 'encoder', 'decoder', 'indexer', 'explorer', 'db', 'miner'])
        })

        it('clears a cold-start miner whose single ping would fail, then sets mining time', async function () {
            const setMiningTimeStub = sinon.stub().resolves(true)
            installConnectors({
                regtestMinerConnector: { ping: async () => false, waitForReady: async () => true, setMiningTime: setMiningTimeStub }
            })

            await runPingSequence()

            assert(setMiningTimeStub.calledOnce)
            assert.deepStrictEqual(setMiningTimeStub.firstCall.args, [1000, 1000])
        })

        it('fails through the real connector when the miner port is dead', async function () {
            const miner = new RegtestMinerConnector('127.0.0.1', await deadPort())
            // Bound the real poll so the refused port exhausts it quickly (the default is 30 s).
            miner.waitForReady = () => RegtestMinerConnector.prototype.waitForReady.call(miner, 300, 50)
            miner.setMiningTime = sinon.stub().resolves(true)
            installConnectors({ regtestMinerConnector: miner })

            await assert.rejects(
                () => runPingSequence(),
                { message: "Can't connect to the XChain Regtest Miner module (not ready after wait)" }
            )
            assert(miner.setMiningTime.notCalled, 'setMiningTime must not run on an unready miner')
        })
    })
}

function registerGasBootstrapTests() {
    describe('Scenario 3.7.5: Gas token bootstrap failure', function () {

        it('throws when gas token issue fails', async function () {
            // Replicate gas token check from initial_check.test.js lines 198-215
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
}

describe('Error Propagation: Setup Errors', function () {

    beforeEach(function () {
        saveGlobals()
    })

    afterEach(function () {
        restoreGlobals()
    })

    registerPingFailuresOne()
    registerPingFailuresTwo()
    registerMinerReadiness()
})

describe('Error Propagation: Setup Errors', function () {

    beforeEach(function () {
        saveGlobals()
    })

    afterEach(function () {
        restoreGlobals()
    })

    registerGasBootstrapTests()
})
