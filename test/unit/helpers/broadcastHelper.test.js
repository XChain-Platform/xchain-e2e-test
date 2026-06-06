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
const helper = require('../../helpers/broadcastHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('broadcastHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForBroadcast: sinon.stub().resolves({ id: 30 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendBroadcastV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendBroadcastV0(addressInfo, 'hello', '42')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'BROADCAST|0|hello|42')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.broadcast, { id: 30 })
        })

        it('should call waitForBroadcast once', async () => {
            await helper.sendBroadcastV0(addressInfo, 'msg', '1')
            assert(global.indexerDatabase.waitForBroadcast.calledOnce)
        })
    })

    describe('sendBroadcastV1', () => {
        it('should build correct message with fee and memo', async () => {
            const result = await helper.sendBroadcastV1(addressInfo, 'hello', '42', '0.5', 'mymemo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'BROADCAST|1|hello|42|0.5|mymemo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.broadcast, { id: 30 })
        })
    })

    describe('sendBroadcastV2', () => {
        it('should build correct message with fee and memo (no value)', async () => {
            const result = await helper.sendBroadcastV2(addressInfo, 'hello', '0.5', 'mymemo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'BROADCAST|2|hello|0.5|mymemo')
            assert.strictEqual(result.txHash, 'abc123')
        })
    })

    describe('sendBroadcastV3', () => {
        it('should build correct message with broadcastActionIndex', async () => {
            const result = await helper.sendBroadcastV3(addressInfo, '7', '99', 'note')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'BROADCAST|3|7|99|note')
            assert.strictEqual(result.txHash, 'abc123')
        })
    })
})
