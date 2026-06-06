'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Integration tests for batch helper → DB assertion pipeline.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const ecc = require('tiny-secp256k1')
const ECPair = ECPairFactory(ecc)

const batchHelper = require('../../../test/helpers/batchHelper')
const transactionHelper = require('../../../test/transactionHelper')
const dbRows = require('../fixtures/dbRows')

describe('Batch Helper → DB Assertion Pipeline', function () {

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
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('txhash_batch')
    })

    afterEach(function () {
        Object.assign(global, savedGlobals)
        sinon.restore()
    })

    describe('Scenario 3.3.4: Batch with embedded sub-messages', function () {

        it('joins sub-actions with semicolon separator', async function () {
            let waitForBatchArgs = null

            global.indexerDatabase = {
                waitForBatch: async function (obj) {
                    waitForBatchArgs = obj
                    return dbRows.batchRow()
                }
            }

            const commands = [
                'SEND|0|MYTOKEN|100|destAddr|memo1',
                'SEND|0|OTHER|50|destAddr2|memo2'
            ]

            const result = await batchHelper.sendBatchV0(addressInfo, commands)

            // Verify message: BATCH|0|cmd1;cmd2
            const message = createTxStub.firstCall.args[1]
            assert.strictEqual(
                message,
                'BATCH|0|SEND|0|MYTOKEN|100|destAddr|memo1;SEND|0|OTHER|50|destAddr2|memo2'
            )

            // Verify waitForBatch filters
            assert(waitForBatchArgs, 'waitForBatch should have been called')
            assert.strictEqual(waitForBatchArgs.txHash, 'txhash_batch')
            assert.strictEqual(waitForBatchArgs.source, addressInfo.address)
            assert.strictEqual(waitForBatchArgs.status, 'valid')

            // Verify return
            assert.strictEqual(result.txHash, 'txhash_batch')
            assert(result.batch, 'batch row should be present')
        })

        it('handles single command batch', async function () {
            global.indexerDatabase = {
                waitForBatch: async () => dbRows.batchRow()
            }

            await batchHelper.sendBatchV0(addressInfo, ['SEND|0|TOK|10|addr|'])

            const message = createTxStub.firstCall.args[1]
            assert.strictEqual(message, 'BATCH|0|SEND|0|TOK|10|addr|')
        })
    })
})
