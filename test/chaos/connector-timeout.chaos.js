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

// Chaos Experiment 1: Connector Timeout Cascade (@P0)
//
// Verifies that polling loops (waitForTx, waitForIssue, waitForUtxos)
// respect their timeMax parameter when the underlying service call
// continuously fails, rather than hanging indefinitely.

const assert = require('assert')
const sinon = require('sinon')
const { createDb, makeMockConnection } = require('./chaos-helpers')
const BlockchainConnector = require('../../src/BlockchainConnector')
const XChainUtxoTrackerConnector = require('../../src/XChainUtxoTrackerConnector')

describe('Chaos Experiment 1 — Connector Timeout Cascade @P0', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('BlockchainConnector.waitForTx', function () {

        it('returns false when getTransactionHex always rejects (ETIMEDOUT)', async function () {
            const bc = new BlockchainConnector('localhost', '18443', 'user', 'pass')
            bc.sleep = sinon.stub().resolves()
            sinon.stub(bc, 'getTransactionHex').rejects(new Error('connect ETIMEDOUT'))

            const result = await bc.waitForTx('deadbeef', 100)

            assert.strictEqual(result, false)
            assert(bc.getTransactionHex.callCount >= 1, 'should have attempted at least one call')
            assert(bc.sleep.callCount >= 0)
        })

        it('returns true immediately when getTransactionHex resolves (even null)', async function () {
            // waitForTx returns true on ANY non-throwing response — it only
            // checks that getTransactionHex didn't throw, not the value.
            const bc = new BlockchainConnector('localhost', '18443', 'user', 'pass')
            bc.sleep = sinon.stub().resolves()
            sinon.stub(bc, 'getTransactionHex').resolves(null)

            const result = await bc.waitForTx('deadbeef', 100)

            assert.strictEqual(result, true)
            assert.strictEqual(bc.getTransactionHex.callCount, 1, 'should return on first success')
        })

        it('returns true when getTransactionHex succeeds after transient failures', async function () {
            const bc = new BlockchainConnector('localhost', '18443', 'user', 'pass')
            bc.sleep = sinon.stub().resolves()
            const stub = sinon.stub(bc, 'getTransactionHex')
            stub.onFirstCall().rejects(new Error('ETIMEDOUT'))
            stub.onSecondCall().rejects(new Error('ETIMEDOUT'))
            stub.onThirdCall().resolves('aabbccdd')

            const result = await bc.waitForTx('deadbeef', 30000)

            assert.strictEqual(result, true)
            assert.strictEqual(stub.callCount, 3)
        })
    })

    describe('Database.waitForIssue', function () {

        it('returns null when query always returns empty rows within timeMax', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            const result = await db.waitForIssue({ tick: 'CHAOS' }, 100)

            assert.strictEqual(result, null)
            assert(mockConn.query.callCount >= 1)
        })

        it('returns null when query always rejects within timeMax', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('connect ETIMEDOUT'))

            const result = await db.waitForIssue({ tick: 'CHAOS' }, 100)

            assert.strictEqual(result, null)
        })

        it('returns row when query recovers after transient timeout', async function () {
            const { db, mockConn } = createDb()
            const mockRow = { tick: 'CHAOS', status: 'valid' }
            mockConn.query.onFirstCall().rejects(new Error('ETIMEDOUT'))
            mockConn.query.onSecondCall().resolves([])
            mockConn.query.onThirdCall().resolves([mockRow])

            const result = await db.waitForIssue({ tick: 'CHAOS' }, 30000)

            assert.deepStrictEqual(result, mockRow)
        })
    })

    describe('XChainUtxoTrackerConnector.waitForUtxos', function () {

        it('returns false when getUtxosFromAddress always returns empty', async function () {
            const tracker = new XChainUtxoTrackerConnector('localhost', '3030')
            tracker.sleep = sinon.stub().resolves()
            sinon.stub(tracker, 'getUtxosFromAddress').resolves({ utxos: [] })

            const result = await tracker.waitForUtxos('addr_chaos', 100)

            assert.strictEqual(result, false)
            assert(tracker.getUtxosFromAddress.callCount >= 1)
        })

        it('returns false when getUtxosFromAddress always rejects', async function () {
            const tracker = new XChainUtxoTrackerConnector('localhost', '3030')
            tracker.sleep = sinon.stub().resolves()
            sinon.stub(tracker, 'getUtxosFromAddress').rejects(new Error('ECONNREFUSED'))

            const result = await tracker.waitForUtxos('addr_chaos', 100)

            assert.strictEqual(result, false)
        })
    })
})
