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
const helper = require('../../helpers/batchHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('batchHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForBatch: sinon.stub().resolves({ id: 130 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendBatchV0', () => {
        it('should join commands with semicolon', async () => {
            const commands = ['SEND|0|TOK|100|addr2|', 'MINT|0|TOK|50|addr1|']
            const result = await helper.sendBatchV0(addressInfo, commands)

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'BATCH|0|SEND|0|TOK|100|addr2|;MINT|0|TOK|50|addr1|')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.batch, { id: 130 })
        })

        it('should handle single command', async () => {
            await helper.sendBatchV0(addressInfo, ['DESTROY|0|TOK|10|'])

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'BATCH|0|DESTROY|0|TOK|10|')
        })

        it('should call waitForBatch with source address', async () => {
            await helper.sendBatchV0(addressInfo, ['CMD1', 'CMD2'])
            assert(global.indexerDatabase.waitForBatch.calledOnce)
            const waitArg = global.indexerDatabase.waitForBatch.firstCall.args[0]
            assert.strictEqual(waitArg.source, 'addr1')
        })
    })
})
