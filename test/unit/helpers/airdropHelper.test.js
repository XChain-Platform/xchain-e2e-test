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
const helper = require('../../helpers/airdropHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('airdropHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForAirdrop: sinon.stub().resolves({ id: 150 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendAirdropV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendAirdropV0(addressInfo, 'TOK', '100', '5', 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'AIRDROP|0|TOK|100|5|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.airdrop, { id: 150 })
        })

        it('should call waitForAirdrop once', async () => {
            await helper.sendAirdropV0(addressInfo, 'TOK', '50', '3', '')
            assert(global.indexerDatabase.waitForAirdrop.callCount === 1)
        })
    })

    describe('sendAirdropV1', () => {
        it('should build correct message with listActionIndex before ticks', async () => {
            const result = await helper.sendAirdropV1(
                addressInfo, 'TOK1', '100', 'TOK2', '200', '7', 'memo'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'AIRDROP|1|7|TOK1|100|TOK2|200|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.airdrop1, { id: 150 })
            assert.deepStrictEqual(result.airdrop2, { id: 150 })
        })

        it('should call waitForAirdrop twice', async () => {
            await helper.sendAirdropV1(addressInfo, 'T1', '10', 'T2', '20', '1', '')
            assert.strictEqual(global.indexerDatabase.waitForAirdrop.callCount, 2)
        })
    })

    describe('sendAirdropV2', () => {
        it('should build correct message with two list action indexes', async () => {
            const result = await helper.sendAirdropV2(
                addressInfo, 'TOK1', '100', 'TOK2', '200', '3', '4', 'memo'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'AIRDROP|2|TOK1|100|3|TOK2|200|4|memo')
            assert.strictEqual(result.txHash, 'abc123')
        })

        it('should call waitForAirdrop twice', async () => {
            await helper.sendAirdropV2(addressInfo, 'T1', '10', 'T2', '20', '1', '2', '')
            assert.strictEqual(global.indexerDatabase.waitForAirdrop.callCount, 2)
        })
    })

    describe('sendAirdropV3', () => {
        it('should build correct message with two individual memos', async () => {
            const result = await helper.sendAirdropV3(
                addressInfo, 'TOK1', '100', 'TOK2', '200', '3', '4', 'memo1', 'memo2'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'AIRDROP|3|TOK1|100|3|memo1|TOK2|200|4|memo2')
            assert.strictEqual(result.txHash, 'abc123')
        })

        it('should call waitForAirdrop twice', async () => {
            await helper.sendAirdropV3(addressInfo, 'T1', '10', 'T2', '20', '1', '2', 'm1', 'm2')
            assert.strictEqual(global.indexerDatabase.waitForAirdrop.callCount, 2)
        })
    })
})
