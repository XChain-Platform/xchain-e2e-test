'use strict'

// Integration tests for negative test assertions — verifying the E2E suite
// can correctly detect and report expected failures.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const ecc = require('tiny-secp256k1')
const ECPair = ECPairFactory(ecc)

const sendHelper = require('../../../test/helpers/sendHelper')
const transactionHelper = require('../../../test/transactionHelper')
const dbRows = require('../fixtures/dbRows')

describe('Error Propagation — Negative Test Assertions', function () {

    let savedGlobals
    let addressInfo
    let createTxStub

    before(function () {
        const keyPair = ECPair.makeRandom({ network: bitcoin.networks.regtest })
        const { address } = bitcoin.payments.p2pkh({
            pubkey: keyPair.publicKey,
            network: bitcoin.networks.regtest
        })
        addressInfo = { address, privateKey: keyPair.privateKey, publicKey: keyPair.publicKey }
    })

    beforeEach(function () {
        savedGlobals = {
            NETWORK_OBJECT: global.NETWORK_OBJECT,
            indexerDatabase: global.indexerDatabase,
        }
        global.NETWORK_OBJECT = { ...bitcoin.networks.regtest, dustThreshold: 546 }
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('txhash_neg')
    })

    afterEach(function () {
        Object.assign(global, savedGlobals)
        sinon.restore()
    })

    describe('Scenario 3.8.1: Invalid send detection', function () {

        it('waitForSend can filter by invalid status', async function () {
            global.indexerDatabase = {
                waitForSend: async function (obj) {
                    // Simulate indexer recording a rejected send
                    if (obj.status === 'invalid: insufficient funds') {
                        return dbRows.sendRow({ status: 'invalid: insufficient funds' })
                    }
                    return null
                },
                waitForCredit: async () => null,
                waitForDebit: async () => null,
            }

            // The send helper always filters with status: "valid"
            // For negative tests, the test file calls waitForSend directly
            const row = await global.indexerDatabase.waitForSend({
                source: addressInfo.address,
                txHash: 'txhash_neg',
                status: 'invalid: insufficient funds'
            })

            assert(row, 'row should exist for invalid status')
            assert.strictEqual(row.status, 'invalid: insufficient funds')
        })
    })

    describe('Scenario 3.8.2: Timeout vs invalid status distinction', function () {

        it('null result from waitForSend is distinguishable from invalid row', function () {
            // Timeout returns null — the test assertion fails with a clear message
            const timeoutResult = null
            assert.throws(
                () => assert(timeoutResult, 'Send should be rejected with insufficient funds'),
                /Send should be rejected with insufficient funds/
            )

            // Invalid row exists — the assertion passes
            const invalidRow = dbRows.sendRow({ status: 'invalid: insufficient funds' })
            assert(invalidRow, 'Send should be rejected with insufficient funds')
        })

        it('valid vs invalid status are distinct assertion targets', function () {
            const validRow = dbRows.sendRow({ status: 'valid' })
            const invalidRow = dbRows.sendRow({ status: 'invalid: insufficient funds' })

            assert.notStrictEqual(validRow.status, invalidRow.status)
            assert.strictEqual(validRow.status, 'valid')
            assert(invalidRow.status.startsWith('invalid:'))
        })
    })
})
