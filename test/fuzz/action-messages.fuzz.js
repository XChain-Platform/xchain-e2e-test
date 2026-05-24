'use strict'

// Fuzz tests for ACTION message string construction.
// Verifies that pipe-delimited message building in action helpers never crashes
// and always produces a string (even with fuzzed field values that undergo
// JavaScript's implicit toString via string concatenation).
//
// Strategy: We stub transactionHelper.createAndSendTransaction and
// indexerDatabase.waitFor* to capture the constructed message string
// and verify it's well-formed enough not to crash the helper.

const assert = require('assert')
const sinon = require('sinon')
const fc = require('fast-check')

const gen = require('./fuzz-generators')

// Inject mock mariadb before requiring anything that depends on db.js
require('../integration/fixtures/mockMariadb')

// ── Globals required by helpers ──────────────────────────────────

global.wallets = {}
global.COIN = 'bitcoin'
global.NETWORK = 'regtest'
global.NETWORK_OBJECT = { dustThreshold: 546 }
global.COIN_CODE = 'BTC'

// Stub connectors at the global level
global.nodeConnector = {
    waitForTx: async () => true,
    broadcastTx: async () => 'txhash-stub',
    getFeePerKilobyte: async () => 0.001,
    getTransactionHex: async () => 'deadbeef',
    getNetworkInfo: async () => ({ version: 1 })
}
global.utxoTrackerConnector = {
    waitForUtxos: async () => true,
    getUtxosFromAddress: async () => ({ utxos: [] })
}
global.encoderConnector = {
    createTx: async () => ({ psbt: 'dead', encoding: 'OP_RETURN' }),
    ping: async () => true
}
global.regtestMinerConnector = {
    sendFunds: async () => 'txid-stub',
    ping: async () => true,
    setMiningTime: async () => true,
    setDefaultMiningTime: async () => true
}
global.indexerConnector = { ping: async () => true }

// Create a mock indexerDatabase with all waitFor*/check* methods
const mockDbResults = {
    issue: { tick: 'TOK', status: 'valid' },
    send: { tick: 'TOK', source: 'addr', status: 'valid' },
    credit: { tick: 'TOK', amount: 100 },
    debit: { tick: 'TOK', amount: 100 },
    mint: { tick: 'TOK', status: 'valid' },
    broadcast: { message: 'msg', status: 'valid' },
    dispenser: { status: 'valid' },
    dispense: { status: 'valid' },
    dispenserStatus: { status: 'open' },
    destroy: { status: 'valid' },
    message: { status: 'valid' },
    file: { status: 'valid' },
    sleep: { status: 'valid' },
    sweep: { status: 'valid' },
    dividend: { status: 'valid' },
    callback: { status: 'valid' },
    order: { status: 'valid' },
    orderMatch: { status: 'valid' },
    swap: { status: 'valid' },
    swapMatch: { status: 'valid' },
    batch: { status: 'valid' },
    link: { status: 'valid' },
    list: { status: 'valid' },
    airdrop: { status: 'valid' },
    addressOption: { status: 'valid' },
    coinpay: { status: 'valid' },
    coinpayObligation: { status: 'valid' },
    stake: { status: 'valid' },
    unstake: { status: 'valid' },
}

global.indexerDatabase = {}
for (const [name, row] of Object.entries(mockDbResults)) {
    const capName = name.charAt(0).toUpperCase() + name.slice(1)
    global.indexerDatabase[`waitFor${capName}`] = async () => row
    global.indexerDatabase[`check${capName}`] = async () => row
}
global.indexerDatabase.ping = async () => true

// ── Capture the message string passed to createAndSendTransaction ─

let capturedMessage = null

const transactionHelper = require('../transactionHelper')

const FC_PARAMS = { numRuns: 200 }

// ── Fuzz helper: test that message construction doesn't crash ────

function fuzzMessageConstruction(helperName, methodName, argsArb) {
    describe(`Fuzz: ${helperName}.${methodName} message construction`, function () {

        let createAndSendStub

        beforeEach(function () {
            capturedMessage = null
            createAndSendStub = sinon.stub(transactionHelper, 'createAndSendTransaction')
                .callsFake(async (addressInfo, data) => {
                    capturedMessage = data
                    return 'txhash-fuzz'
                })
        })

        afterEach(function () {
            sinon.restore()
        })

        it(`survives ${FC_PARAMS.numRuns} fuzzed inputs without crashing`, async function () {
            const helper = require(`../helpers/${helperName}`)

            await fc.assert(fc.asyncProperty(argsArb, async (args) => {
                capturedMessage = null
                const fakeAddressInfo = { address: 'fuzz_addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

                try {
                    await helper[methodName](fakeAddressInfo, ...args)
                    // The message must be a string (result of string concatenation)
                    assert(typeof capturedMessage === 'string',
                        `${helperName}.${methodName} should produce a string message, got: ${typeof capturedMessage}`)
                } catch (err) {
                    // TypeError from string concatenation with Symbol is acceptable
                    // but any other crash is a fuzz finding
                    if (err instanceof TypeError && err.message.includes('Cannot convert a Symbol')) {
                        return // Expected: Symbol cannot be concatenated
                    }
                    throw err
                }
            }), FC_PARAMS)
        })
    })
}

// ── ACTION field tuple generators ────────────────────────────────

const f = gen.actionFieldArb

describe('Fuzz — ACTION Message Construction', function () {

    // ISSUE V0: tick, maxSupply, maxMint, decimals, description, mintSupply
    fuzzMessageConstruction('issueHelper', 'sendIssueV0',
        fc.tuple(f, f, f, f, f, f))

    // ISSUE V1: tick, description
    fuzzMessageConstruction('issueHelper', 'sendIssueV1',
        fc.tuple(f, f))

    // SEND V0: tick, amount, destination, memo
    fuzzMessageConstruction('sendHelper', 'sendSendV0',
        fc.tuple(f, f, f, f))

    // SEND V1: tick, amount1, destination1, amount2, destination2, memo
    fuzzMessageConstruction('sendHelper', 'sendSendV1',
        fc.tuple(f, f, f, f, f, f))

    // MINT V0: tick, amount, destination, memo
    fuzzMessageConstruction('mintHelper', 'sendMintV0',
        fc.tuple(f, f, f, f))

    // BROADCAST V0: message, value
    fuzzMessageConstruction('broadcastHelper', 'sendBroadcastV0',
        fc.tuple(f, f))

    // BROADCAST V1: message, value, fee, memo
    fuzzMessageConstruction('broadcastHelper', 'sendBroadcastV1',
        fc.tuple(f, f, f, f))

    // DESTROY V0: tick, amount, memo
    fuzzMessageConstruction('destroyHelper', 'sendDestroyV0',
        fc.tuple(f, f, f))

    // SWEEP V0: destination, balances, ownerships, orders, swaps, dispensers, memo
    fuzzMessageConstruction('sweepHelper', 'sendSweepV0',
        fc.tuple(f, f, f, f, f, f, f))

    // DIVIDEND V0: tick, dividendTick, amount, memo
    fuzzMessageConstruction('dividendHelper', 'sendDividendV0',
        fc.tuple(f, f, f, f))

    // CALLBACK V0: tick, memo
    fuzzMessageConstruction('callbackHelper', 'sendCallbackV0',
        fc.tuple(f, f))

    // SLEEP V0: resumeBlock, memo
    fuzzMessageConstruction('sleepHelper', 'sendSleepV0',
        fc.tuple(f, f))

    // ADDRESS V0: feePreference, requireMemo, memo
    fuzzMessageConstruction('addressHelper', 'sendAddressV0',
        fc.tuple(f, f, f))

    // LINK V0: coin1, coin1ActionIndex, coin2, coin2ActionIndex, memo
    fuzzMessageConstruction('linkHelper', 'sendLinkV0',
        fc.tuple(f, f, f, f, f))

    // FILE V0: name, type, title, memo
    fuzzMessageConstruction('fileHelper', 'sendFileV0',
        fc.tuple(f, f, f, f))

    // MESSAGE V0: destination, plaintextMessage
    fuzzMessageConstruction('messageHelper', 'sendMessageV0',
        fc.tuple(f, f))

    // ── Pipe delimiter injection ─────────────────────────────────

    describe('Pipe delimiter injection in ACTION fields', function () {

        let createAndSendStub

        beforeEach(function () {
            capturedMessage = null
            createAndSendStub = sinon.stub(transactionHelper, 'createAndSendTransaction')
                .callsFake(async (addressInfo, data) => {
                    capturedMessage = data
                    return 'txhash-fuzz'
                })
        })

        afterEach(function () {
            sinon.restore()
        })

        it('tick containing pipe characters produces message with extra fields', async function () {
            const issueHelper = require('../helpers/issueHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await issueHelper.sendIssueV1(fakeAddr, 'EVIL|TICK', 'description')

            // The message will contain the pipe from the tick, creating ambiguity
            assert(typeof capturedMessage === 'string')
            // Count pipes — should be 3 for "ISSUE|1|tick|description" but will be 4
            const pipeCount = (capturedMessage.match(/\|/g) || []).length
            assert(pipeCount > 3, `Pipe in tick should increase field count: got ${pipeCount} pipes`)
        })

        it('description containing pipes does not crash ISSUE V0', async function () {
            const issueHelper = require('../helpers/issueHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await issueHelper.sendIssueV0(fakeAddr, 'TOK', 1000, 100, 0, 'desc|with|pipes', 500)

            assert(typeof capturedMessage === 'string')
        })

        it('memo containing pipes does not crash SEND V0', async function () {
            const sendHelper = require('../helpers/sendHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await sendHelper.sendSendV0(fakeAddr, 'TOK', 100, 'dest', 'memo|with|pipes')

            assert(typeof capturedMessage === 'string')
        })
    })

    // ── Null/undefined coercion in string concatenation ──────────

    describe('Null/undefined field coercion', function () {

        let createAndSendStub

        beforeEach(function () {
            capturedMessage = null
            createAndSendStub = sinon.stub(transactionHelper, 'createAndSendTransaction')
                .callsFake(async (addressInfo, data) => {
                    capturedMessage = data
                    return 'txhash-fuzz'
                })
        })

        afterEach(function () {
            sinon.restore()
        })

        it('null tick becomes "null" string literal in ISSUE V1', async function () {
            const issueHelper = require('../helpers/issueHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await issueHelper.sendIssueV1(fakeAddr, null, 'desc')

            assert(capturedMessage.includes('null'),
                'null should be coerced to "null" string via concatenation')
        })

        it('undefined amount becomes "undefined" string literal in SEND V0', async function () {
            const sendHelper = require('../helpers/sendHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await sendHelper.sendSendV0(fakeAddr, 'TOK', undefined, 'dest', 'memo')

            assert(capturedMessage.includes('undefined'),
                'undefined should be coerced to "undefined" string via concatenation')
        })

        it('NaN amount becomes "NaN" string literal in MINT V0', async function () {
            const mintHelper = require('../helpers/mintHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await mintHelper.sendMintV0(fakeAddr, 'TOK', NaN, 'dest', 'memo')

            assert(capturedMessage.includes('NaN'),
                'NaN should be coerced to "NaN" string via concatenation')
        })

        it('object field becomes "[object Object]" in BROADCAST V0', async function () {
            const broadcastHelper = require('../helpers/broadcastHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await broadcastHelper.sendBroadcastV0(fakeAddr, { evil: true }, 100)

            assert(capturedMessage.includes('[object Object]'),
                'object should be coerced to "[object Object]" string via concatenation')
        })

        it('array field becomes comma-joined string in BROADCAST V0', async function () {
            const broadcastHelper = require('../helpers/broadcastHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await broadcastHelper.sendBroadcastV0(fakeAddr, [1, 2, 3], 100)

            assert(capturedMessage.includes('1,2,3'),
                'array should be coerced to comma-joined string via concatenation')
        })
    })
})
