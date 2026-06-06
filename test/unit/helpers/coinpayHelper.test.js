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
const helper = require('../../helpers/coinpayHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('coinpayHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForCoinpay: sinon.stub().resolves({ id: 190 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendCoinpayV0', () => {
        it('should build correct message with only orderMatchActionIndex', async () => {
            const result = await helper.sendCoinpayV0(addressInfo, '42', 'payeeAddr', 100000)

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'COINPAY|0|42')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.coinpay, { id: 190 })
        })

        it('should pass null as third arg and customOutputs as fourth arg', async () => {
            await helper.sendCoinpayV0(addressInfo, '7', 'sellerAddr', 50000)

            assert.strictEqual(createTxStub.firstCall.args[2], null)
            const customOutputs = createTxStub.firstCall.args[3]
            assert(Array.isArray(customOutputs))
            assert.strictEqual(customOutputs.length, 1)
            assert.strictEqual(customOutputs[0].address, 'sellerAddr')
            assert.strictEqual(customOutputs[0].value, 50000)
        })

        it('should call waitForCoinpay with obligationActionIndex', async () => {
            await helper.sendCoinpayV0(addressInfo, '99', 'addr2', 1000)
            assert(global.indexerDatabase.waitForCoinpay.calledOnce)
            const waitArg = global.indexerDatabase.waitForCoinpay.firstCall.args[0]
            assert.strictEqual(waitArg.obligationActionIndex, '99')
        })
    })
})
