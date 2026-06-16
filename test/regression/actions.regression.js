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

const assert = require('assert')
const sinon  = require('sinon')

// Set up globals for transactionHelper (used by action helpers)
global.wallets               = {}
global.NETWORK_OBJECT        = require('bitcoinjs-lib').networks.regtest
global.encoderConnector      = { createTx: async () => ({}) }
global.nodeConnector         = { broadcastTx: async () => 'txhash-stub', waitForTx: async () => true }
global.utxoTrackerConnector  = { getUtxosFromAddress: async () => ({ utxos: [] }), waitForUtxos: async () => true }
global.regtestMinerConnector = { sendFunds: async () => 'txid-stub' }
global.indexerDatabase       = {
    waitForIssue:   sinon.stub().resolves({ tick: 'TOK', status: 'valid' }),
    waitForSend:    sinon.stub().resolves({ tick: 'TOK', status: 'valid' }),
    waitForCredit:  sinon.stub().resolves({ tick: 'TOK', amount: '100' }),
    waitForDebit:   sinon.stub().resolves({ tick: 'TOK', amount: '100' }),
    waitForMint:    sinon.stub().resolves({ tick: 'TOK', status: 'valid' }),
    waitForDestroy: sinon.stub().resolves({ tick: 'TOK', status: 'valid' }),
    waitForBatch:   sinon.stub().resolves({ status: 'valid' }),
    waitForSweep:   sinon.stub().resolves({ status: 'valid' }),
}

const transactionHelper = require('../transactionHelper')
const issueHelper       = require('../helpers/issueHelper')
const sendHelper        = require('../helpers/sendHelper')

// ═══════════════════════════════════════════════════════════════════════════
// P1 — Action Helper Regression Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('[regression:p1] Action Helpers', function () {

    let createTxStub

    beforeEach(function () {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('txhash-test')

        // Reset waitFor stubs
        global.indexerDatabase.waitForIssue  = sinon.stub().resolves({ tick: 'TOK', status: 'valid' })
        global.indexerDatabase.waitForSend   = sinon.stub().resolves({ tick: 'TOK', status: 'valid' })
        global.indexerDatabase.waitForCredit = sinon.stub().resolves({ tick: 'TOK', amount: '100' })
        global.indexerDatabase.waitForDebit  = sinon.stub().resolves({ tick: 'TOK', amount: '100' })
        global.indexerDatabase.waitForMint   = sinon.stub().resolves({ tick: 'TOK', status: 'valid' })
    })

    afterEach(function () {
        sinon.restore()
    })

    const fakeAddr = { address: 'addr1', privateKey: Buffer.alloc(32, 1), publicKey: Buffer.alloc(33, 2) }

    // ── R-ACT-001 — ISSUE message construction ──────────────────────────

    describe('issueHelper', function () {

        it('[regression:p1] R-ACT-001 — sendIssueV0 constructs correct pipe-delimited message', async function () {
            await issueHelper.sendIssueV0(fakeAddr, 'MYTOKEN', 1000, 100, 8, 'Test', 50)

            assert.ok(createTxStub.calledOnce)
            const message = createTxStub.firstCall.args[1]
            assert.ok(message.startsWith('ISSUE|0|'), 'should start with ISSUE|0|')
            assert.ok(message.includes('MYTOKEN'), 'should include tick')
            assert.ok(message.includes('1000'), 'should include maxSupply')
            assert.ok(message.includes('100'), 'should include maxMint')
            assert.ok(message.includes('8'), 'should include decimals')
            assert.ok(message.includes('Test'), 'should include description')
            assert.ok(message.includes('50'), 'should include mintSupply')
        })

        it('[regression:p1] R-ACT-001b — sendIssueV0 calls waitForIssue and waitForCredit', async function () {
            await issueHelper.sendIssueV0(fakeAddr, 'TOK', 1000, 100, 8, 'desc', 50)

            assert.ok(global.indexerDatabase.waitForIssue.calledOnce, 'waitForIssue should be called')
            assert.ok(global.indexerDatabase.waitForCredit.calledOnce, 'waitForCredit should be called')

            // Verify filter args
            const issueFilter = global.indexerDatabase.waitForIssue.firstCall.args[0]
            assert.strictEqual(issueFilter.source, 'addr1')
            assert.strictEqual(issueFilter.tick, 'TOK')
            assert.strictEqual(issueFilter.status, 'valid')
        })

        it('[regression:p1] R-ACT-001c — sendIssueV0 returns txHash, issue, and credit', async function () {
            const result = await issueHelper.sendIssueV0(fakeAddr, 'TOK', 1000, 100, 8, 'desc', 50)

            assert.strictEqual(result.txHash, 'txhash-test')
            assert.ok(result.issue, 'should return issue row')
            assert.ok(result.credit, 'should return credit row')
        })

        it('[regression:p1] R-ACT-001d — sendIssueV1 constructs V1 message with tick and description', async function () {
            global.indexerDatabase.waitForIssue = sinon.stub().resolves({ tick: 'TOK' })

            await issueHelper.sendIssueV1(fakeAddr, 'TOK', 'new desc')

            const message = createTxStub.firstCall.args[1]
            assert.strictEqual(message, 'ISSUE|1|TOK|new desc')
        })

        it('[regression:p1] R-ACT-005a — sendIssueV0 passes addressInfo as first arg to createAndSendTransaction', async function () {
            await issueHelper.sendIssueV0(fakeAddr, 'TOK', 1000, 100, 8, 'desc', 50)

            assert.strictEqual(createTxStub.firstCall.args[0], fakeAddr)
        })
    })

    // ── R-ACT-002 — SEND message construction ───────────────────────────

    describe('sendHelper', function () {

        it('[regression:p1] R-ACT-002 — sendSendV0 constructs correct pipe-delimited message', async function () {
            await sendHelper.sendSendV0(fakeAddr, 'TOK', '100', 'dest1', 'memo1')

            assert.ok(createTxStub.calledOnce)
            const message = createTxStub.firstCall.args[1]
            assert.strictEqual(message, 'SEND|0|TOK|100|dest1|memo1')
        })

        it('[regression:p1] R-ACT-002b — sendSendV0 calls waitForSend, waitForCredit, waitForDebit', async function () {
            await sendHelper.sendSendV0(fakeAddr, 'TOK', '100', 'dest1', 'memo1')

            assert.ok(global.indexerDatabase.waitForSend.calledOnce)
            assert.ok(global.indexerDatabase.waitForCredit.calledOnce)
            assert.ok(global.indexerDatabase.waitForDebit.calledOnce)

            // Credit goes to destination
            const creditFilter = global.indexerDatabase.waitForCredit.firstCall.args[0]
            assert.strictEqual(creditFilter.address, 'dest1')

            // Debit comes from source
            const debitFilter = global.indexerDatabase.waitForDebit.firstCall.args[0]
            assert.strictEqual(debitFilter.address, 'addr1')
        })

        it('[regression:p1] R-ACT-002c — sendSendV0 returns txHash, send, credit, debit', async function () {
            const result = await sendHelper.sendSendV0(fakeAddr, 'TOK', '100', 'dest1', '')

            assert.strictEqual(result.txHash, 'txhash-test')
            assert.ok(result.send)
            assert.ok(result.credit)
            assert.ok(result.debit)
        })

        it('[regression:p1] R-ACT-006 — sendSendV1 calls waitForSend twice for two destinations', async function () {
            await sendHelper.sendSendV1(fakeAddr, 'TOK', '50', 'dest1', '30', 'dest2', 'memo')

            assert.strictEqual(global.indexerDatabase.waitForSend.callCount, 2)
            assert.strictEqual(global.indexerDatabase.waitForCredit.callCount, 2)
        })
    })

    // ── R-ACT-007 — error handling ───────────────────────────────────────

    describe('error handling', function () {

        it('[regression:p1] R-ACT-007 — action helper propagates createAndSendTransaction errors', async function () {
            createTxStub.restore()
            sinon.stub(transactionHelper, 'createAndSendTransaction').rejects(new Error('encoder down'))

            await assert.rejects(
                () => issueHelper.sendIssueV0(fakeAddr, 'TOK', 1000, 100, 8, 'desc', 50),
                /encoder down/
            )
        })
    })
})
