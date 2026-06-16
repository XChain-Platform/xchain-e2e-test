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
const helper = require('../../helpers/callbackHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('callbackHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForCallback: sinon.stub().resolves({ id: 100 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendCallbackV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendCallbackV0(addressInfo, 'MYTOKEN', 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'CALLBACK|0|MYTOKEN|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.callback, { id: 100 })
        })

        it('should call waitForCallback once with correct args', async () => {
            await helper.sendCallbackV0(addressInfo, 'TOK', '')
            assert(global.indexerDatabase.waitForCallback.calledOnce)
            const waitArg = global.indexerDatabase.waitForCallback.firstCall.args[0]
            assert.strictEqual(waitArg.tick, 'TOK')
            assert.strictEqual(waitArg.source, 'addr1')
        })
    })
})
