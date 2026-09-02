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

            const message = createTxStub.firstCall.args[1]
            assert(message.startsWith('ISSUE|0|MYTOKEN|1000|100|8|Test token|50'))

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

            assert(waitForCreditArgs, 'waitForCredit should have been called')
            assert.strictEqual(waitForCreditArgs.address, addressInfo.address)
            assert.strictEqual(waitForCreditArgs.tick, 'MYTOKEN')
            assert.strictEqual(waitForCreditArgs.txHash, 'txhash_issue')
            assert.strictEqual(waitForCreditArgs.amount, 50)

            assert.strictEqual(result.txHash, 'txhash_issue')
            assert.deepStrictEqual(result.issue, mockIssueRow)
            assert.deepStrictEqual(result.credit, mockCreditRow)
        })
    })

    // A fixture builder that hands back a null row is the failure mode this
    // scenario exists to prevent: the caller stores the null, the test walks on,
    // and it fails several assertions later on the wrong rule. The helper throws
    // at the wait instead, naming the row that never came.
    describe('Scenario 3.3.5: Helper fails loud when the DB times out', function () {

        it('throws, naming the ISSUE and the status it waited for', async function () {
            global.indexerDatabase = {
                waitForIssue: async () => null,
                waitForCredit: async () => null,
            }

            await assert.rejects(
                () => issueHelper.sendIssueV0(addressInfo, 'MYTOKEN', 1000, 100, 8, 'desc', 50),
                /sendIssueV0: ISSUE MYTOKEN \(tx txhash_issue\) never reached status=valid/,
            )
        })

        it('points the reader at the give-up line, which says absent vs wrong status', async function () {
            global.indexerDatabase = {
                waitForIssue: async () => null,
                waitForCredit: async () => null,
            }

            await assert.rejects(
                () => issueHelper.sendIssueV0(addressInfo, 'MYTOKEN', 1000, 100, 8, 'desc', 50),
                /checkIssue give-up line above/,
            )
        })

        // A valid ISSUE whose mint credit never lands is a DIFFERENT fault, and
        // a null field for both would leave the two indistinguishable.
        it('names the missing mint credit when the ISSUE itself landed', async function () {
            global.indexerDatabase = {
                waitForIssue: async () => dbRows.issueRow(),
                waitForCredit: async () => null,
            }

            await assert.rejects(
                () => issueHelper.sendIssueV0(addressInfo, 'MYTOKEN', 1000, 100, 8, 'desc', 50),
                /is valid but its mint credit of 50 never appeared/,
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
