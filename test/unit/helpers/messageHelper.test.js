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

const sinon = require('sinon')
const assert = require('assert')
const transactionHelper = require('../../transactionHelper')
const helper = require('../../helpers/messageHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('messageHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForMessage: sinon.stub().resolves({ id: 60 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendMessageV3', () => {
        it('should build correct message for plaintext', async () => {
            const result = await helper.sendMessageV3(addressInfo, 'dest1', 'Hello world')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'MESSAGE|3|dest1|Hello world')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.message, { id: 60 })
        })

        it('should call waitForMessage once', async () => {
            await helper.sendMessageV3(addressInfo, 'dest1', 'text')
            assert(global.indexerDatabase.waitForMessage.calledOnce)
        })
    })

    describe('sendMessageV0', () => {
        it('should build correct message for sender-key encryption', async () => {
            const result = await helper.sendMessageV0(addressInfo, 'dest1', 'AES256', 'pubkey123')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'MESSAGE|0|dest1|AES256|pubkey123')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.message, { id: 60 })
        })
    })

    describe('sendMessageV1', () => {
        it('should build correct message for receiver-key encryption', async () => {
            const result = await helper.sendMessageV1(addressInfo, 'dest1', 'RSA', 'recvkey456')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'MESSAGE|1|dest1|RSA|recvkey456')
            assert.strictEqual(result.txHash, 'abc123')
        })
    })

    describe('sendMessageV2', () => {
        it('should build correct message for pre-encrypted message', async () => {
            const result = await helper.sendMessageV2(addressInfo, 'dest1', 'encryptedblob')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'MESSAGE|2|dest1|encryptedblob')
            assert.strictEqual(result.txHash, 'abc123')
        })
    })
})
