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
const helper = require('../../helpers/sweepHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('sweepHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForSweep: sinon.stub().resolves({ id: 90 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendSweepV0', () => {
        it('should build correct message with explicit values', async () => {
            // balances|ownerships|orders|swaps|dispensers
            const result = await helper.sendSweepV0(addressInfo, 'dest1', 1, 1, 1, 0, 1, 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SWEEP|0|dest1|1|1|1|0|1|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.sweep, { id: 90 })
        })

        it('should default null balances to 1, ownerships to 1, orders/swaps/dispensers to 0', async () => {
            await helper.sendSweepV0(addressInfo, 'dest1', null, null, null, null, null, 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SWEEP|0|dest1|1|1|0|0|0|memo')
        })

        it('should call waitForSweep once', async () => {
            await helper.sendSweepV0(addressInfo, 'dest1', 1, 1, 0, 0, 0, '')
            assert(global.indexerDatabase.waitForSweep.calledOnce)
        })

        it('should pass source address to waitForSweep', async () => {
            await helper.sendSweepV0(addressInfo, 'dest1', 1, 0, 0, 0, 0, '')
            const waitArg = global.indexerDatabase.waitForSweep.firstCall.args[0]
            assert.strictEqual(waitArg.source, 'addr1')
            assert.strictEqual(waitArg.destination, 'dest1')
        })
    })
})
