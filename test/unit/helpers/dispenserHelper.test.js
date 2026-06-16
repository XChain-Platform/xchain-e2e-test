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
const helper = require('../../helpers/dispenserHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

// Replace setTimeout globally so the 5-second sleep resolves immediately
function stubTimeout() {
    return sinon.stub(global, 'setTimeout').callsFake((fn) => { fn(); return 0 })
}

describe('dispenserHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForDispenser: sinon.stub().resolves({ id: 160 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendDispenserV0', () => {
        it('should build correct message with all params', async () => {
            const result = await helper.sendDispenserV0(
                addressInfo,
                'BTC', 'TOK', '100', '50',
                'LTC', 'LTOK', '200', 'getAddr',
                'USD', '9.99', '1000',
                'allowList1', 'blockList1', 'memo'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'DISPENSER|0|BTC|TOK|100|50|LTC|LTOK|200|getAddr|USD|9.99|1000|allowList1|blockList1|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.dispenser, { id: 160 })
        })

        it('should replace null params with empty string', async () => {
            await helper.sendDispenserV0(
                addressInfo,
                null, null, '100', '50',
                null, null, '200', 'getAddr',
                null, null, null,
                null, null, 'memo'
            )

            const msg = createTxStub.firstCall.args[1]
            // giveCoin, giveTick, getCoin, getTick null→""; fiatCode, fiatAmount, expiration, allowList, blockList null→""
            assert.strictEqual(msg, 'DISPENSER|0|||100|50|||200|getAddr||||||memo')
        })

        it('should call waitForDispenser once', async () => {
            await helper.sendDispenserV0(
                addressInfo, 'BTC', 'T', '1', '1', 'LTC', 'T2', '2', 'addr', '', '', '', '', '', ''
            )
            assert(global.indexerDatabase.waitForDispenser.calledOnce)
        })
    })

    describe('sendDispenserCancelV1', () => {
        it('should build correct message and skip waitFor', async () => {
            stubTimeout()
            const result = await helper.sendDispenserCancelV1(addressInfo, '42', 'note')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'DISPENSER|1|42|note')
            assert.strictEqual(result.txHash, 'abc123')
            assert.strictEqual(result.dispenser, undefined)
        })

        it('should use empty string for undefined memo', async () => {
            stubTimeout()
            await helper.sendDispenserCancelV1(addressInfo, '7')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'DISPENSER|1|7|')
        })
    })

    describe('sendDispenserEditV2', () => {
        it('should build correct message with all params', async () => {
            stubTimeout()
            const result = await helper.sendDispenserEditV2(
                addressInfo, '10', '75', '2000', 'allow2', 'block2', 'edit-memo'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'DISPENSER|2|10|75|2000|allow2|block2|edit-memo')
            assert.strictEqual(result.txHash, 'abc123')
        })

        it('should replace null params with empty string', async () => {
            stubTimeout()
            await helper.sendDispenserEditV2(
                addressInfo, '10', null, null, null, null, 'memo'
            )

            const msg = createTxStub.firstCall.args[1]
            // giveEscrow, expiration, allowList, blockList all null→"" → 4 empty → 5 pipes before memo
            assert.strictEqual(msg, 'DISPENSER|2|10|||||memo')
        })
    })
})
