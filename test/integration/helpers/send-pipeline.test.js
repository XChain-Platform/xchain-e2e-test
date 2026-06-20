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

// Integration tests for the send helper → DB assertion pipeline.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const ecc = require('tiny-secp256k1')
const ECPair = ECPairFactory(ecc)

const sendHelper = require('../../../test/helpers/sendHelper')
const transactionHelper = require('../../../test/transactionHelper')
const dbRows = require('../fixtures/dbRows')

describe('Send Helper → DB Assertion Pipeline', function () {

    let savedGlobals
    let addressInfo
    let destAddress
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

        const destKeyPair = ECPair.makeRandom({ network: bitcoin.networks.regtest })
        destAddress = bitcoin.payments.p2pkh({
            pubkey: destKeyPair.publicKey,
            network: bitcoin.networks.regtest
        }).address
    })

    beforeEach(function () {
        savedGlobals = {
            NETWORK_OBJECT: global.NETWORK_OBJECT,
            indexerDatabase: global.indexerDatabase,
        }
        global.NETWORK_OBJECT = { ...bitcoin.networks.regtest, dustThreshold: 546 }
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('txhash_send')
    })

    afterEach(function () {
        Object.assign(global, savedGlobals)
        sinon.restore()
    })

    describe('Scenario 3.3.2: Send V0 with destination verification', function () {

        it('passes correct filters including destination, credit, and debit', async function () {
            let waitForSendArgs = null
            let waitForCreditArgs = null
            let waitForDebitArgs = null

            global.indexerDatabase = {
                waitForSend: async function (obj) {
                    waitForSendArgs = obj
                    return dbRows.sendRow({ source: addressInfo.address, destination: destAddress })
                },
                waitForCredit: async function (obj) {
                    waitForCreditArgs = obj
                    return dbRows.creditRow({ address: destAddress })
                },
                waitForDebit: async function (obj) {
                    waitForDebitArgs = obj
                    return dbRows.debitRow({ address: addressInfo.address })
                },
            }

            const result = await sendHelper.sendSendV0(
                addressInfo, 'MYTOKEN', '100', destAddress, 'test memo'
            )

            const message = createTxStub.firstCall.args[1]
            assert.strictEqual(message, 'SEND|0|MYTOKEN|100|' + destAddress + '|test memo')

            assert.strictEqual(waitForSendArgs.source, addressInfo.address)
            assert.strictEqual(waitForSendArgs.destination, destAddress)
            assert.strictEqual(waitForSendArgs.tick, 'MYTOKEN')
            assert.strictEqual(waitForSendArgs.amount, '100')
            assert.strictEqual(waitForSendArgs.txHash, 'txhash_send')
            assert.strictEqual(waitForSendArgs.memo, 'test memo')
            assert.strictEqual(waitForSendArgs.status, 'valid')

            assert.strictEqual(waitForCreditArgs.address, destAddress)
            assert.strictEqual(waitForCreditArgs.tick, 'MYTOKEN')
            assert.strictEqual(waitForCreditArgs.amount, '100')

            assert.strictEqual(waitForDebitArgs.address, addressInfo.address)
            assert.strictEqual(waitForDebitArgs.tick, 'MYTOKEN')
            assert.strictEqual(waitForDebitArgs.amount, '100')

            assert.strictEqual(result.txHash, 'txhash_send')
            assert(result.send, 'send row should be present')
            assert(result.credit, 'credit row should be present')
            assert(result.debit, 'debit row should be present')
        })
    })

    describe('Send V1 multi-destination', function () {

        it('calls waitForSend twice and waitForCredit twice', async function () {
            let sendCalls = 0
            let creditCalls = 0

            const destKeyPair2 = ECPair.makeRandom({ network: bitcoin.networks.regtest })
            const destAddress2 = bitcoin.payments.p2pkh({
                pubkey: destKeyPair2.publicKey,
                network: bitcoin.networks.regtest
            }).address

            global.indexerDatabase = {
                waitForSend: async () => { sendCalls++; return dbRows.sendRow() },
                waitForCredit: async () => { creditCalls++; return dbRows.creditRow() },
                waitForDebit: async () => dbRows.debitRow(),
            }

            const result = await sendHelper.sendSendV1(
                addressInfo, 'MYTOKEN', '50', destAddress, '30', destAddress2, 'memo'
            )

            assert.strictEqual(sendCalls, 2, 'waitForSend called twice (one per destination)')
            assert.strictEqual(creditCalls, 2, 'waitForCredit called twice (one per destination)')
            assert(result.send1, 'send1 row exists')
            assert(result.send2, 'send2 row exists')
            assert(result.credit1, 'credit1 row exists')
            assert(result.credit2, 'credit2 row exists')
            assert(result.debit, 'debit row exists')
        })
    })
})
