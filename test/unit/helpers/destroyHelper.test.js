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
const transactionHelper = require('../../helpers/core/transactionHelper')
const helper = require('../../helpers/destroyHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('destroyHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForDestroy: sinon.stub().resolves({ id: 40 }),
            waitForDebit: sinon.stub().resolves({ id: 41 }),
            waitForDestroyLegs: sinon.stub().callsFake(async () =>
                global.indexerDatabase.waitForDestroy.getCalls().map((call, i) => ({
                    id: 40 + i,
                    leg_ordinal: i,
                    tick: call.args[0].tick,
                    amount: call.args[0].amount,
                }))),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendDestroyV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendDestroyV0(addressInfo, 'TOK', '100', 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'DESTROY|0|TOK|100|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.destroy, { id: 40 })
            assert.deepStrictEqual(result.debit, { id: 41 })
        })

        it('should call waitForDestroy and waitForDebit', async () => {
            await helper.sendDestroyV0(addressInfo, 'TOK', '100', '')
            assert(global.indexerDatabase.waitForDestroy.calledOnce)
            assert(global.indexerDatabase.waitForDebit.calledOnce)
        })
    })

    describe('sendDestroyV1', () => {
        it('should build correct message for array of destroys with memo', async () => {
            const destroys = [{ tick: 'TOK1', amount: '50' }, { tick: 'TOK2', amount: '30' }]
            const result = await helper.sendDestroyV1(addressInfo, destroys, 'mymemo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'DESTROY|1|TOK1|50|TOK2|30|mymemo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.strictEqual(result.destroy.id, 41)
            assert.deepStrictEqual(result.destroys.map(row => row.tick), ['TOK1', 'TOK2'])
            assert.strictEqual(result.debit, undefined)
            assert.strictEqual(global.indexerDatabase.waitForDestroy.callCount, 2)
        })

        it('should omit memo when not provided', async () => {
            const destroys = [{ tick: 'TOK', amount: '100' }]
            await helper.sendDestroyV1(addressInfo, destroys)

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'DESTROY|1|TOK|100')
        })

        it('should only call waitForDestroy, not waitForDebit', async () => {
            await helper.sendDestroyV1(addressInfo, [{ tick: 'T', amount: '1' }], '')
            assert(global.indexerDatabase.waitForDestroy.calledOnce)
            assert(global.indexerDatabase.waitForDebit.notCalled)
        })

        it('should reject duplicate ticks before sending', async () => {
            await assert.rejects(
                helper.sendDestroyV1(addressInfo, [{ tick: 'T', amount: '1' }, { tick: 'T', amount: '2' }]),
                /duplicate destroy leg/
            )
            assert(createTxStub.notCalled)
        })
    })

    describe('sendDestroyV2', () => {
        it('should build correct message for array of destroys with individual memos', async () => {
            const destroys = [
                { tick: 'TOK1', amount: '50', memo: 'note1' },
                { tick: 'TOK2', amount: '30', memo: 'note2' }
            ]
            const result = await helper.sendDestroyV2(addressInfo, destroys)

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'DESTROY|2|TOK1|50|note1|TOK2|30|note2')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.destroys.map(row => row.tick), ['TOK1', 'TOK2'])
            assert.strictEqual(global.indexerDatabase.waitForDestroy.callCount, 2)
        })

        it('should use empty string for missing memo', async () => {
            const destroys = [{ tick: 'TOK', amount: '100' }]
            await helper.sendDestroyV2(addressInfo, destroys)

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'DESTROY|2|TOK|100|')
        })

        it('should reject a missing or reordered leg set', async () => {
            global.indexerDatabase.waitForDestroyLegs.resolves([
                { leg_ordinal: 0, tick: 'TOK2', amount: '30' },
                { leg_ordinal: 1, tick: 'TOK1', amount: '50' },
            ])
            await assert.rejects(() => helper.sendDestroyV2(addressInfo, [
                { tick: 'TOK1', amount: '50' },
                { tick: 'TOK2', amount: '30' },
            ]), /does not match wire order/)
        })
    })
})
