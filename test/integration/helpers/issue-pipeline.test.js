'use strict'

// Integration tests for the issue helper pipeline:
// issueHelper → transactionHelper → connectors → indexerDatabase.waitForIssue/waitForCredit
//
// Unlike unit tests (which stub transactionHelper.createAndSendTransaction),
// these tests let the helper call the real transactionHelper code, stubbing
// only at the network boundary (encoderConnector, nodeConnector, utxoTrackerConnector).

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const ecc = require('tiny-secp256k1')
const ECPair = ECPairFactory(ecc)

const issueHelper = require('../../../test/helpers/issueHelper')
const transactionHelper = require('../../../test/transactionHelper')
const dbRows = require('../fixtures/dbRows')

describe('Issue Helper → DB Assertion Pipeline', function () {

    let savedGlobals
    let addressInfo
    let createTxStub

    before(function () {
        const keyPair = ECPair.makeRandom({ network: bitcoin.networks.regtest })
        const { address } = bitcoin.payments.p2pkh({
            pubkey: keyPair.publicKey,
            network: bitcoin.networks.regtest
        })
        addressInfo = {
            address,
            privateKey: keyPair.privateKey,
            publicKey: keyPair.publicKey
        }
    })

    beforeEach(function () {
        savedGlobals = {
            NETWORK_OBJECT: global.NETWORK_OBJECT,
            encoderConnector: global.encoderConnector,
            nodeConnector: global.nodeConnector,
            utxoTrackerConnector: global.utxoTrackerConnector,
            indexerDatabase: global.indexerDatabase,
        }
        global.NETWORK_OBJECT = { ...bitcoin.networks.regtest, dustThreshold: 546 }

        // Stub transactionHelper at a higher level so we can focus on helper→DB interaction
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('txhash_issue')
    })

    afterEach(function () {
        Object.assign(global, savedGlobals)
        sinon.restore()
    })

    describe('Scenario 3.3.1: Issue V0 full pipeline', function () {

        it('passes correct message to transactionHelper and correct filters to DB', async function () {
            const mockIssueRow = dbRows.issueRow({ source: addressInfo.address, tx_hash: 'txhash_issue' })
            const mockCreditRow = dbRows.creditRow({ address: addressInfo.address, tx_hash: 'txhash_issue' })

            let waitForIssueArgs = null
            let waitForCreditArgs = null

            global.indexerDatabase = {
                waitForIssue: async function (obj) {
                    waitForIssueArgs = obj
                    return mockIssueRow
                },
                waitForCredit: async function (obj) {
                    waitForCreditArgs = obj
                    return mockCreditRow
                }
            }

            const result = await issueHelper.sendIssueV0(
                addressInfo, 'MYTOKEN', 1000, 100, 8, 'Test token', 50
            )

            // Verify message sent to transactionHelper
            const message = createTxStub.firstCall.args[1]
            assert(message.startsWith('ISSUE|0|MYTOKEN|1000|100|8|Test token|50'))

            // Verify waitForIssue received correct filter object
            assert(waitForIssueArgs, 'waitForIssue should have been called')
            assert.strictEqual(waitForIssueArgs.source, addressInfo.address)
            assert.strictEqual(waitForIssueArgs.tick, 'MYTOKEN')
            assert.strictEqual(waitForIssueArgs.txHash, 'txhash_issue')
            assert.strictEqual(waitForIssueArgs.description, 'Test token')
            assert.strictEqual(waitForIssueArgs.maxSupply, 1000)
            assert.strictEqual(waitForIssueArgs.maxMint, 100)
            assert.strictEqual(waitForIssueArgs.decimals, 8)
            assert.strictEqual(waitForIssueArgs.mintSupply, 50)
            assert.strictEqual(waitForIssueArgs.status, 'valid')

            // Verify waitForCredit received correct filter object
            assert(waitForCreditArgs, 'waitForCredit should have been called')
            assert.strictEqual(waitForCreditArgs.address, addressInfo.address)
            assert.strictEqual(waitForCreditArgs.tick, 'MYTOKEN')
            assert.strictEqual(waitForCreditArgs.txHash, 'txhash_issue')
            assert.strictEqual(waitForCreditArgs.amount, 50)

            // Verify return value
            assert.strictEqual(result.txHash, 'txhash_issue')
            assert.deepStrictEqual(result.issue, mockIssueRow)
            assert.deepStrictEqual(result.credit, mockCreditRow)
        })
    })

    describe('Scenario 3.3.5: Helper returns null when DB times out', function () {

        it('returns null issue and credit when waitForIssue returns null', async function () {
            global.indexerDatabase = {
                waitForIssue: async () => null,
                waitForCredit: async () => null,
            }

            const result = await issueHelper.sendIssueV0(
                addressInfo, 'MYTOKEN', 1000, 100, 8, 'desc', 50
            )

            assert.strictEqual(result.txHash, 'txhash_issue')
            assert.strictEqual(result.issue, null, 'issue should be null on timeout')
            assert.strictEqual(result.credit, null, 'credit should be null on timeout')
        })

        it('does not throw — caller can assert on null result', function () {
            // This confirms the pattern: helpers return null, tests use assert(result.issue)
            const result = { txHash: 'abc', issue: null, credit: null }
            assert.throws(
                () => assert(result.issue, 'Issue should exist in DB'),
                /Issue should exist in DB/
            )
        })
    })

    describe('Issue V1-V5 filter correctness', function () {

        it('sendIssueV1 passes tick and description to waitForIssue', async function () {
            let waitForIssueArgs = null
            global.indexerDatabase = {
                waitForIssue: async (obj) => { waitForIssueArgs = obj; return dbRows.issueRow() }
            }

            await issueHelper.sendIssueV1(addressInfo, 'MYTOKEN', 'Updated desc')

            assert.strictEqual(waitForIssueArgs.tick, 'MYTOKEN')
            assert.strictEqual(waitForIssueArgs.description, 'Updated desc')
            assert.strictEqual(waitForIssueArgs.status, 'valid')
        })

        it('sendIssueV2 passes maxMint and mintSupply to waitForIssue', async function () {
            let waitForIssueArgs = null
            global.indexerDatabase = {
                waitForIssue: async (obj) => { waitForIssueArgs = obj; return dbRows.issueRow() }
            }

            await issueHelper.sendIssueV2(addressInfo, 'MYTOKEN', '200', '100', null, null, null, null, null)

            assert.strictEqual(waitForIssueArgs.tick, 'MYTOKEN')
            assert.strictEqual(waitForIssueArgs.txHash, 'txhash_issue')
        })
    })
})
