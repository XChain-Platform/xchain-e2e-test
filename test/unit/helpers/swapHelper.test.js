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
const helper = require('../../helpers/swapHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

function stubTimeout() {
    return sinon.stub(global, 'setTimeout').callsFake((fn) => { fn(); return 0 })
}

describe('swapHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForSwap: sinon.stub().resolves({ id: 180 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendSwapV0', () => {
        it('should build correct message with all params', async () => {
            const result = await helper.sendSwapV0(
                addressInfo, 'BTC', 'TOK', '100', 'LTC', 'LTOK', '200',
                'getAddr', '1000', 'allow1', 'block1', 'memo'
            )

            const msg = createTxStub.firstCall.args[1]
            // Canonical SWAP v0: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|
            // GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|
            // BLOCK_LIST|MEMO. Both ownership fields are empty for a normal swap.
            assert.strictEqual(msg, 'SWAP|0|BTC|TOK|100||LTC|LTOK|200||getAddr|1000|allow1|block1|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.swap, { id: 180 })
        })

        it('should replace null optional params with empty string', async () => {
            await helper.sendSwapV0(
                addressInfo, 'BTC', 'TOK', '100', 'LTC', 'LTOK', '200',
                null, null, null, null, 'memo'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SWAP|0|BTC|TOK|100||LTC|LTOK|200||||||memo')
        })

        it('should call waitForSwap once', async () => {
            await helper.sendSwapV0(
                addressInfo, 'BTC', 'T', '1', 'LTC', 'T2', '2', '', '', '', '', ''
            )
            assert(global.indexerDatabase.waitForSwap.calledOnce)
        })
    })

    describe('sendSwapCancelV1', () => {
        it('should build correct message and skip waitFor', async () => {
            stubTimeout()
            const result = await helper.sendSwapCancelV1(addressInfo, '99', 'cancel')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SWAP|1|99|cancel')
            assert.strictEqual(result.txHash, 'abc123')
            assert.strictEqual(result.swap, undefined)
        })
    })

    describe('sendSwapEditV2', () => {
        it('should build correct message with all params', async () => {
            stubTimeout()
            const result = await helper.sendSwapEditV2(
                addressInfo, '30', '3000', 'allowX', 'blockX', 'edit-note'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SWAP|2|30|3000|allowX|blockX|edit-note')
            assert.strictEqual(result.txHash, 'abc123')
        })

        it('should replace null optional params with empty string', async () => {
            stubTimeout()
            await helper.sendSwapEditV2(addressInfo, '8', null, null, null, 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SWAP|2|8||||memo')
        })
    })
})
