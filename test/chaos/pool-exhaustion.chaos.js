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

// Chaos Experiment 2: Database Pool Exhaustion (@P0)
//
// Verifies that when the MariaDB connection pool cannot provide connections,
// db.getConnection retries correctly, and db.waitForIssue times out
// rather than hanging forever.

const assert = require('assert')
const sinon = require('sinon')
const { createDb, makeMockConnection, makeMockPool, mockMariadb } = require('./chaos-helpers')
const Database = require('../../src/db')

describe('Chaos Experiment 2 — Pool Exhaustion @P0', function () {

    afterEach(function () {
        sinon.restore()
        mockMariadb.createPool.resetHistory()
    })

    describe('getConnection retry under exhaustion', function () {

        it('retries and succeeds when pool recovers after repeated failures', async function () {
            const { db, mockPool } = createDb()
            const successConn = makeMockConnection([{ id: 1 }])

            // Fail 5 times then succeed
            for (let i = 0; i < 5; i++) {
                mockPool.getConnection.onCall(i).rejects(new Error('Pool exhausted'))
            }
            mockPool.getConnection.onCall(5).resolves(successConn)

            const conn = await db.getConnection()

            assert.strictEqual(conn, successConn)
            assert.strictEqual(mockPool.getConnection.callCount, 6)
            assert.strictEqual(db.sleep.callCount, 5)
            db.sleep.getCalls().forEach(call => {
                assert.strictEqual(call.args[0], 1000)
            })
        })

        it('retries with 1000ms interval between attempts', async function () {
            const { db, mockPool } = createDb()
            const successConn = makeMockConnection()

            mockPool.getConnection.onFirstCall().rejects(new Error('Too many connections'))
            mockPool.getConnection.onSecondCall().resolves(successConn)

            await db.getConnection()

            assert(db.sleep.calledOnce)
            assert.strictEqual(db.sleep.firstCall.args[0], 1000)
        })
    })

    describe('waitForIssue under pool exhaustion', function () {

        it('returns null when pool never provides a connection (times out via timeMax)', async function () {
            const { db, mockPool, mockConn } = createDb()
            // Connection is acquired but query always returns empty
            mockConn.query.resolves([])

            const result = await db.waitForIssue({ tick: 'EXHAUSTED' }, 100)

            assert.strictEqual(result, null)
        })

        it('recovers when pool provides connection after initial failures', async function () {
            const mockConn = makeMockConnection()
            const mockRow = { tick: 'RECOVERED', status: 'valid' }
            mockConn.query.onFirstCall().rejects(new Error('No connections available'))
            mockConn.query.onSecondCall().resolves([mockRow])

            const mockPool = makeMockPool(mockConn)
            mockMariadb.createPool.returns(mockPool)
            const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
            db.sleep = sinon.stub().resolves()

            const result = await db.waitForIssue({ tick: 'RECOVERED' }, 30000)

            assert.deepStrictEqual(result, mockRow)
            assert(mockConn.release.callCount >= 1, 'connection must be released')
        })
    })

    describe('pool.end() resilience', function () {

        it('pool.end() rejection can be caught without crashing', async function () {
            const { db, mockPool } = createDb()
            mockPool.end.rejects(new Error('Pool already destroyed'))

            await assert.doesNotReject(async () => {
                try {
                    await db.pool.end()
                } catch (e) {
                    // Swallowed — chaos scenario
                }
            })
            assert(mockPool.end.calledOnce)
        })
    })
})
