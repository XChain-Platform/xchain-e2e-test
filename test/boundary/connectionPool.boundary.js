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

// Boundary tests for Database connection pool behavior at operational limits.
// Tests pool exhaustion, connection failure retries, and resource cleanup.

const assert = require('assert')
const sinon = require('sinon')

// Inject mock mariadb before requiring db.js
const mockMariadb = require('../integration/fixtures/mockMariadb')
const Database = require('../../src/db')

// ── Helpers ──────────────────────────────────────────────────────

function makeMockConnection(queryResult) {
    return {
        query: sinon.stub().resolves(queryResult !== undefined ? queryResult : []),
        release: sinon.stub().resolves(),
    }
}

function createDb() {
    const mockConn = makeMockConnection()
    const mockPool = { getConnection: sinon.stub().resolves(mockConn) }
    mockMariadb.createPool.returns(mockPool)
    const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
    db.sleep = sinon.stub().resolves()
    return { db, mockConn, mockPool }
}

describe('Boundary — Connection Pool', function () {

    afterEach(function () {
        sinon.restore()
        mockMariadb.createPool.resetHistory()
    })

    // ── CP-01: Pool exhaustion — many concurrent getConnection calls ────

    describe('CP-01: Concurrent getConnection calls', function () {

        it('handles 10+ concurrent getConnection calls without crashing', async function () {
            const { db, mockPool } = createDb()
            const connections = []

            // Each call returns a fresh mock connection
            mockPool.getConnection.callsFake(async () => makeMockConnection())

            // Fire 15 concurrent getConnection calls
            const promises = []
            for (let i = 0; i < 15; i++) {
                promises.push(db.getConnection())
            }

            const results = await Promise.all(promises)

            assert.strictEqual(results.length, 15, 'all 15 calls should resolve')
            assert.strictEqual(mockPool.getConnection.callCount, 15)
            results.forEach(conn => {
                assert.ok(conn, 'each connection should be truthy')
                assert.ok(typeof conn.query === 'function', 'each connection should have query method')
            })
        })
    })

    // ── CP-02: getConnection retry with multiple consecutive failures ───

    describe('CP-02: getConnection retries on consecutive failures', function () {

        it('retries multiple times and succeeds when pool recovers', async function () {
            const { db, mockPool } = createDb()
            const successConn = makeMockConnection([{ id: 1 }])

            // Fail 5 times, then succeed
            mockPool.getConnection.onCall(0).rejects(new Error('ECONNREFUSED'))
            mockPool.getConnection.onCall(1).rejects(new Error('ECONNREFUSED'))
            mockPool.getConnection.onCall(2).rejects(new Error('ECONNREFUSED'))
            mockPool.getConnection.onCall(3).rejects(new Error('ECONNREFUSED'))
            mockPool.getConnection.onCall(4).rejects(new Error('ECONNREFUSED'))
            mockPool.getConnection.onCall(5).resolves(successConn)

            const conn = await db.getConnection()

            assert.strictEqual(conn, successConn)
            assert.strictEqual(mockPool.getConnection.callCount, 6, 'retried 5 times + 1 success')
            assert.strictEqual(db.sleep.callCount, 5, 'slept after each failure')
            db.sleep.getCalls().forEach(call => {
                assert.strictEqual(call.args[0], 1000, 'each retry sleeps 1000ms')
            })
        })
    })

    // ── CP-03: Connection drop during waitFor* poll ─────────────────────

    describe('CP-03: Connection failure mid-poll recovers', function () {

        it('waitForIssue continues polling after getConnection failure', async function () {
            const { db, mockPool } = createDb()
            const mockRow = { tick: 'TOK', status: 'valid' }

            const failConn = makeMockConnection()
            failConn.query.rejects(new Error('Connection lost'))

            const successConn = makeMockConnection([mockRow])

            // First getConnection returns a connection that will fail on query,
            // second returns a working connection
            mockPool.getConnection.onFirstCall().resolves(failConn)
            mockPool.getConnection.onSecondCall().resolves(successConn)

            const result = await db.waitForIssue({ tick: 'TOK' }, 30000)

            assert.deepStrictEqual(result, mockRow)
            // Both connections should have been released
            assert(failConn.release.calledOnce, 'failed connection released')
            assert(successConn.release.calledOnce, 'success connection released')
        })
    })

    // ── CP-04: Connection release on all check* methods ─────────────────

    describe('CP-04: Connection always released regardless of query outcome', function () {

        it('releases connection after successful checkIssue', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([{ tick: 'TOK' }])

            await db.checkIssue({ tick: 'TOK' })

            assert(mockConn.release.calledOnce)
        })

        it('releases connection after checkIssue returns no rows', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkIssue({ tick: 'NONEXISTENT' })

            assert(mockConn.release.calledOnce)
        })

        it('releases connection after checkIssue query error', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('syntax error'))

            await db.checkIssue({ tick: 'TOK' })

            assert(mockConn.release.calledOnce)
        })

        it('releases connection after successful checkSend', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([{ source: 'addr1' }])

            await db.checkSend({ source: 'addr1' })

            assert(mockConn.release.calledOnce)
        })

        it('releases connection after checkSend query error', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('table missing'))

            await db.checkSend({ source: 'addr1' })

            assert(mockConn.release.calledOnce)
        })

        it('releases connection after checkCredit query error', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('timeout'))

            await db.checkCredit({ tick: 'TOK' })

            assert(mockConn.release.calledOnce)
        })

        it('releases connection after checkDebit query error', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('timeout'))

            await db.checkDebit({ tick: 'TOK' })

            assert(mockConn.release.calledOnce)
        })
    })

    // ── CP-05: transactionConnection bypass ─────────────────────────────

    describe('CP-05: transactionConnection takes precedence over pool', function () {

        it('returns transactionConnection without calling pool.getConnection', async function () {
            const { db, mockPool } = createDb()
            const txConn = makeMockConnection([{ id: 99 }])
            db.transactionConnection = txConn

            const conn = await db.getConnection()

            assert.strictEqual(conn, txConn)
            assert(mockPool.getConnection.notCalled, 'pool should not be used when txConn is set')
        })
    })

    // ── CP-06: Pool created with correct parameters ─────────────────────

    describe('CP-06: Database constructor passes correct pool params', function () {

        it('creates pool with connectionLimit of 10', function () {
            const { db } = createDb()
            const poolParams = mockMariadb.createPool.lastCall.args[0]

            assert.strictEqual(poolParams.connectionLimit, 10)
            assert.strictEqual(poolParams.insertIdAsNumber, true)
            assert.strictEqual(poolParams.host, 'localhost')
            assert.strictEqual(poolParams.port, 3306)
            assert.strictEqual(poolParams.database, 'test_db')
            assert.strictEqual(poolParams.user, 'user')
            assert.strictEqual(poolParams.password, 'pass')
        })
    })

    // ── CP-07: Ping releases connection on both success and failure ─────

    describe('CP-07: ping boundary — connection management', function () {

        it('releases connection after successful ping', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([{ '1 + 1': 2 }])

            const result = await db.ping()

            assert.strictEqual(result, true)
            assert(mockConn.release.calledOnce)
        })

        it('releases connection after ping query fails', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('connection lost'))

            const result = await db.ping()

            assert.strictEqual(result, false)
            assert(mockConn.release.calledOnce)
        })

        it('returns false when query returns empty result', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            const result = await db.ping()

            assert.strictEqual(result, false)
            assert(mockConn.release.calledOnce)
        })
    })
})
