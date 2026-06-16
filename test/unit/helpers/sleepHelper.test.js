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
const helper = require('../../helpers/sleepHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('sleepHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForSleep: sinon.stub().resolves({ id: 80 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendSleepV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendSleepV0(addressInfo, '500', 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SLEEP|0|500|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.sleep, { id: 80 })
        })

        it('should call waitForSleep once', async () => {
            await helper.sendSleepV0(addressInfo, '100', '')
            assert(global.indexerDatabase.waitForSleep.calledOnce)
        })
    })

    describe('sendSleepV1', () => {
        it('should build correct message including tick', async () => {
            const result = await helper.sendSleepV1(addressInfo, '600', 'MYTOKEN', 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SLEEP|1|600|MYTOKEN|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.sleep, { id: 80 })
        })

        it('should call waitForSleep with tick param', async () => {
            await helper.sendSleepV1(addressInfo, '200', 'TOK', '')
            const waitArg = global.indexerDatabase.waitForSleep.firstCall.args[0]
            assert.strictEqual(waitArg.tick, 'TOK')
        })
    })
})
