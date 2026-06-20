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

// Integration tests for Database class connection pool management.
//
// Mocking strategy: mariadb is an ESM package that cannot be require()'d
// directly. We inject a synthetic CJS module into require.cache before
// requiring db.js, same as the unit tests.

const assert = require('assert')
const sinon = require('sinon')

const mockMariadb = require('../fixtures/mockMariadb')
const Database = require('../../../src/db')

let mockPool
let mockConnection

function makeMockConnection(queryResult) {
    return {
        query: sinon.stub().resolves(queryResult !== undefined ? queryResult : [{ id: 1 }]),
        release: sinon.stub().resolves(),
    }
}

function makeMockPool(connection) {
    return {
        getConnection: sinon.stub().resolves(connection),
    }
}

function createDb() {
    mockConnection = makeMockConnection()
    mockPool = makeMockPool(mockConnection)
    mockMariadb.createPool.returns(mockPool)
    return new Database('localhost', 3306, 'test_db', 'user', 'pass')
}

describe('Database Connection Pool Integration', function () {

    afterEach(function () {
        sinon.restore()
        mockMariadb.createPool.resetHistory()
    })

    describe('Scenario 3.4.1: Connection acquisition', function () {

        it('getConnection returns a connection from the pool', async function () {
            const db = createDb()
            const conn = await db.getConnection()

            assert.strictEqual(conn, mockConnection)
            assert(mockPool.getConnection.calledOnce)
        })

        it('getConnection returns transactionConnection when set', async function () {
            const db = createDb()
            const txConn = makeMockConnection()
            db.transactionConnection = txConn

            const conn = await db.getConnection()

            assert.strictEqual(conn, txConn)
            assert(mockPool.getConnection.notCalled, 'pool should not be called when txConn is set')
        })
    })

    describe('Scenario 3.4.2: Connection pool retry on transient failure', function () {

        it('retries when pool.getConnection throws, succeeds on second attempt', async function () {
            const db = createDb()
            // Override sleep to avoid real delays
            db.sleep = sinon.stub().resolves()

            const successConn = makeMockConnection()
            mockPool.getConnection.onFirstCall().rejects(new Error('ECONNREFUSED'))
            mockPool.getConnection.onSecondCall().resolves(successConn)

            const conn = await db.getConnection()

            assert.strictEqual(conn, successConn)
            assert.strictEqual(mockPool.getConnection.callCount, 2, 'getConnection called twice')
            assert(db.sleep.calledOnce, 'slept once between retries')
            assert.strictEqual(db.sleep.firstCall.args[0], 1000, 'slept 1 second')
        })
    })

    describe('Scenario 3.4.3: Query error during check*', function () {

        it('checkIssue returns null and releases connection on query error', async function () {
            const db = createDb()
            mockConnection.query.rejects(new Error('MariaDB syntax error'))

            const result = await db.checkIssue({ tick: 'MYTOKEN' })

            assert.strictEqual(result, null, 'returns null on error')
            assert(mockConnection.release.calledOnce, 'connection released despite error')
        })

        it('checkSend returns null and releases connection on query error', async function () {
            const db = createDb()
            mockConnection.query.rejects(new Error('table not found'))

            const result = await db.checkSend({ source: 'addr1' })

            assert.strictEqual(result, null)
            assert(mockConnection.release.calledOnce)
        })
    })

    describe('Scenario 3.4.4: Connection release on success', function () {

        it('checkIssue releases connection after returning a row', async function () {
            const db = createDb()
            const mockRow = { tick: 'MYTOKEN', status: 'valid' }
            mockConnection.query.resolves([mockRow])

            const result = await db.checkIssue({ tick: 'MYTOKEN' })

            assert.deepStrictEqual(result, mockRow)
            assert(mockConnection.release.calledOnce, 'connection released after success')
        })

        it('checkIssue releases connection after returning null (no rows)', async function () {
            const db = createDb()
            mockConnection.query.resolves([])

            const result = await db.checkIssue({ tick: 'NONEXISTENT' })

            assert.strictEqual(result, null)
            assert(mockConnection.release.calledOnce, 'connection released when no rows found')
        })

        it('ping releases connection on success', async function () {
            const db = createDb()
            mockConnection.query.resolves([{ '1 + 1': 2 }])

            const result = await db.ping()

            assert.strictEqual(result, true)
            assert(mockConnection.release.calledOnce)
        })

        it('ping releases connection on failure', async function () {
            const db = createDb()
            mockConnection.query.rejects(new Error('connection lost'))

            const result = await db.ping()

            assert.strictEqual(result, false)
            assert(mockConnection.release.calledOnce)
        })
    })

    describe('Query builder integration: WHERE clause construction', function () {

        it('checkIssue builds correct WHERE with multiple filters', async function () {
            const db = createDb()
            mockConnection.query.resolves([])

            await db.checkIssue({ source: 'addr1', tick: 'TOK', status: 'valid' })

            const query = mockConnection.query.firstCall.args[0]
            const params = mockConnection.query.firstCall.args[1]

            assert(query.includes('ia.address = ?'), 'query includes source filter')
            assert(query.includes('itick.tick = ?'), 'query includes tick filter')
            assert(query.includes('ist.status = ?'), 'query includes status filter')
            assert.deepStrictEqual(params, ['addr1', 'TOK', 'valid'])
        })

        it('checkSend builds correct WHERE with destination and memo', async function () {
            const db = createDb()
            mockConnection.query.resolves([])

            await db.checkSend({ source: 'addr1', destination: 'addr2', memo: 'test' })

            const query = mockConnection.query.firstCall.args[0]
            const params = mockConnection.query.firstCall.args[1]

            assert(query.includes('ia.address = ?'), 'query includes source')
            assert(query.includes('ia2.address = ?'), 'query includes destination')
            assert(query.includes('im.memo = ?'), 'query includes memo')
            assert.deepStrictEqual(params, ['addr1', 'addr2', 'test'])
        })

        it('checkIssue omits null fields from WHERE clause', async function () {
            const db = createDb()
            mockConnection.query.resolves([])

            await db.checkIssue({ tick: 'TOK', source: null, status: null })

            const query = mockConnection.query.firstCall.args[0]
            const params = mockConnection.query.firstCall.args[1]

            // Extract just the WHERE portion. JOINs legitimately contain ia.address/ist.status.
            const whereClause = query.split('WHERE')[1] || ''

            assert(whereClause.includes('itick.tick = ?'), 'WHERE includes tick')
            assert(!whereClause.includes('ia.address'), 'WHERE omits null source')
            assert(!whereClause.includes('ist.status'), 'WHERE omits null status')
            assert.deepStrictEqual(params, ['TOK'])
        })
    })
})
