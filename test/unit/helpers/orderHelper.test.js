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
const helper = require('../../helpers/orderHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

function stubTimeout() {
    return sinon.stub(global, 'setTimeout').callsFake((fn) => { fn(); return 0 })
}

describe('orderHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForOrder: sinon.stub().resolves({ id: 170 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendOrderV0', () => {
        it('should build correct message with all params', async () => {
            const result = await helper.sendOrderV0(
                addressInfo, 'BTC', 'TOK', '100', 'LTC', 'LTOK', '200',
                'getAddr', '1000', 'allow1', 'block1', 'memo'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'ORDER|0|BTC|TOK|100|LTC|LTOK|200|getAddr|1000|allow1|block1|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.order, { id: 170 })
        })

        it('should replace null optional params with empty string', async () => {
            await helper.sendOrderV0(
                addressInfo, 'BTC', 'TOK', '100', 'LTC', 'LTOK', '200',
                null, null, null, null, 'memo'
            )

            const msg = createTxStub.firstCall.args[1]
            // getAddress, expiration, allowList, blockList all null→"" → 4 empty fields → 5 pipes
            assert.strictEqual(msg, 'ORDER|0|BTC|TOK|100|LTC|LTOK|200|||||memo')
        })

        it('should call waitForOrder once', async () => {
            await helper.sendOrderV0(
                addressInfo, 'BTC', 'T', '1', 'LTC', 'T2', '2', '', '', '', '', ''
            )
            assert(global.indexerDatabase.waitForOrder.calledOnce)
        })
    })

    describe('sendOrderCancelV1', () => {
        it('should build correct message and skip waitFor', async () => {
            stubTimeout()
            const result = await helper.sendOrderCancelV1(addressInfo, '15', 'cancel-note')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'ORDER|1|15|cancel-note')
            assert.strictEqual(result.txHash, 'abc123')
            assert.strictEqual(result.order, undefined)
        })
    })

    describe('sendOrderEditV2', () => {
        it('should build correct message with all params', async () => {
            stubTimeout()
            const result = await helper.sendOrderEditV2(
                addressInfo, '20', '2000', 'allow2', 'block2', 'edit'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'ORDER|2|20|2000|allow2|block2|edit')
            assert.strictEqual(result.txHash, 'abc123')
        })

        it('should replace null optional params with empty string', async () => {
            stubTimeout()
            await helper.sendOrderEditV2(addressInfo, '5', null, null, null, 'memo')

            const msg = createTxStub.firstCall.args[1]
            // expiration, allowList, blockList all null→"" → 3 empty → 4 pipes before memo
            assert.strictEqual(msg, 'ORDER|2|5||||memo')
        })
    })
})
