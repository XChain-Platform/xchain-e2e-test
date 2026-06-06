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
const helper = require('../../helpers/linkHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('linkHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForLink: sinon.stub().resolves({ id: 140 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendLinkV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendLinkV0(addressInfo, 'BTC', '10', 'LTC', '20', 'note')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'LINK|0|BTC|10|LTC|20|note')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.link, { id: 140 })
        })

        it('should call waitForLink with correct coin and index params', async () => {
            await helper.sendLinkV0(addressInfo, 'BTC', '5', 'DOGE', '8', '')
            assert(global.indexerDatabase.waitForLink.calledOnce)
            const waitArg = global.indexerDatabase.waitForLink.firstCall.args[0]
            assert.strictEqual(waitArg.coin1, 'BTC')
            assert.strictEqual(waitArg.coin1ActionIndex, '5')
            assert.strictEqual(waitArg.coin2, 'DOGE')
            assert.strictEqual(waitArg.coin2ActionIndex, '8')
        })
    })
})
