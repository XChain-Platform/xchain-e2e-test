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
const helper = require('../../helpers/addressHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('addressHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForAddressOption: sinon.stub().resolves({ id: 120 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendAddressV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendAddressV0(addressInfo, '1', '0', 'note')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'ADDRESS|0|1|0|note')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.addressOption, { id: 120 })
        })

        it('should call waitForAddressOption with correct args', async () => {
            await helper.sendAddressV0(addressInfo, '2', '1', '')
            assert(global.indexerDatabase.waitForAddressOption.calledOnce)
            const waitArg = global.indexerDatabase.waitForAddressOption.firstCall.args[0]
            assert.strictEqual(waitArg.feePreference, '2')
            assert.strictEqual(waitArg.requireMemo, '1')
            assert.strictEqual(waitArg.source, 'addr1')
        })
    })
})
