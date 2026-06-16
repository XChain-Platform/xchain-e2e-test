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
const helper = require('../../helpers/listHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('listHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForList: sinon.stub().resolves({ id: 50 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendListV0', () => {
        it('should build correct message joining items with pipe', async () => {
            const result = await helper.sendListV0(addressInfo, 'allowlist', ['item1', 'item2', 'item3'])

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'LIST|0|allowlist|item1|item2|item3')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.list, { id: 50 })
        })

        it('should handle single item', async () => {
            await helper.sendListV0(addressInfo, 'blocklist', ['addr99'])

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'LIST|0|blocklist|addr99')
        })

        it('should call waitForList once', async () => {
            await helper.sendListV0(addressInfo, 'type', ['a'])
            assert(global.indexerDatabase.waitForList.calledOnce)
        })
    })

    describe('sendListV1', () => {
        it('should build correct message for list edit', async () => {
            const result = await helper.sendListV1(
                addressInfo, 'add', '5', ['newitem1', 'newitem2'],
                'allowlist', ['existing', 'newitem1', 'newitem2']
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'LIST|1|add|5|newitem1|newitem2')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.list, { id: 50 })
        })

        it('should pass finalTypeToCheck and finalItemsToCheck to waitForList', async () => {
            const finalItems = ['a', 'b']
            await helper.sendListV1(addressInfo, 'remove', '3', ['b'], 'mytype', finalItems)

            const waitArg = global.indexerDatabase.waitForList.firstCall.args[0]
            assert.strictEqual(waitArg.type, 'mytype')
            assert.deepStrictEqual(waitArg.items, finalItems)
        })
    })
})
