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

const sinon = require('sinon')
const assert = require('assert')
const transactionHelper = require('../../transactionHelper')
const helper = require('../../helpers/sendHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('sendHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForSend: sinon.stub().resolves({ id: 10 }),
            waitForCredit: sinon.stub().resolves({ id: 11 }),
            waitForDebit: sinon.stub().resolves({ id: 12 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendSendV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendSendV0(addressInfo, 'TOK', '100', 'dest1', 'hello')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SEND|0|TOK|100|dest1|hello')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.send, { id: 10 })
            assert.deepStrictEqual(result.credit, { id: 11 })
            assert.deepStrictEqual(result.debit, { id: 12 })
        })

        it('should call waitForSend, waitForCredit, and waitForDebit', async () => {
            await helper.sendSendV0(addressInfo, 'TOK', '100', 'dest1', 'memo')
            assert(global.indexerDatabase.waitForSend.calledOnce)
            assert(global.indexerDatabase.waitForCredit.calledOnce)
            assert(global.indexerDatabase.waitForDebit.calledOnce)
        })
    })

    describe('sendSendV1', () => {
        it('should build correct message for dual send same tick', async () => {
            const result = await helper.sendSendV1(
                addressInfo, 'TOK', '50', 'dest1', '30', 'dest2', 'memo'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SEND|1|TOK|50|dest1|30|dest2|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.send1, { id: 10 })
            assert.deepStrictEqual(result.send2, { id: 10 })
            assert.deepStrictEqual(result.credit1, { id: 11 })
            assert.deepStrictEqual(result.credit2, { id: 11 })
            assert.deepStrictEqual(result.debit, { id: 12 })
        })

        it('should call waitForSend twice, waitForCredit twice, waitForDebit once', async () => {
            await helper.sendSendV1(addressInfo, 'TOK', '50', 'dest1', '30', 'dest2', 'memo')
            assert.strictEqual(global.indexerDatabase.waitForSend.callCount, 2)
            assert.strictEqual(global.indexerDatabase.waitForCredit.callCount, 2)
            assert.strictEqual(global.indexerDatabase.waitForDebit.callCount, 1)
        })
    })

    describe('sendSendV2', () => {
        it('should build correct message for dual send different ticks', async () => {
            const result = await helper.sendSendV2(
                addressInfo, 'TOK1', '50', 'dest1', 'TOK2', '30', 'dest2', 'memo'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SEND|2|TOK1|50|dest1|TOK2|30|dest2|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert(result.send1 !== undefined)
            assert(result.send2 !== undefined)
            assert(result.credit1 !== undefined)
            assert(result.credit2 !== undefined)
            assert(result.debit1 !== undefined)
            assert(result.debit2 !== undefined)
        })

        it('should call waitForSend twice, waitForCredit twice, waitForDebit twice', async () => {
            await helper.sendSendV2(addressInfo, 'T1', '10', 'd1', 'T2', '20', 'd2', 'memo')
            assert.strictEqual(global.indexerDatabase.waitForSend.callCount, 2)
            assert.strictEqual(global.indexerDatabase.waitForCredit.callCount, 2)
            assert.strictEqual(global.indexerDatabase.waitForDebit.callCount, 2)
        })
    })

    describe('sendSendV3', () => {
        it('should build correct message for dual send with individual memos', async () => {
            const result = await helper.sendSendV3(
                addressInfo, 'TOK1', '50', 'dest1', 'memo1', 'TOK2', '30', 'dest2', 'memo2'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SEND|3|TOK1|50|dest1|memo1|TOK2|30|dest2|memo2')
            assert.strictEqual(result.txHash, 'abc123')
        })

        it('should call all waitFor methods twice', async () => {
            await helper.sendSendV3(addressInfo, 'T1', '10', 'd1', 'm1', 'T2', '20', 'd2', 'm2')
            assert.strictEqual(global.indexerDatabase.waitForSend.callCount, 2)
            assert.strictEqual(global.indexerDatabase.waitForCredit.callCount, 2)
            assert.strictEqual(global.indexerDatabase.waitForDebit.callCount, 2)
        })
    })
})
