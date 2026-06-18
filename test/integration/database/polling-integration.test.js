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

// Integration tests for the waitFor* polling pattern:
// waitForIssue/waitForSend → checkIssue/checkSend → getConnection → query → release
//
// Uses the same mariadb mock injection as the unit tests.

const assert = require('assert')
const sinon = require('sinon')

// Inject mock mariadb before requiring db.js
const mockMariadb = require('../fixtures/mockMariadb')
const Database = require('../../../src/db')

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
    return { db, mockConn, mockPool }
}

describe('Database Polling Integration', function () {

    afterEach(function () {
        sinon.restore()
        mockMariadb.createPool.resetHistory()
    })

    describe('Scenario: Immediate success (no sleep needed)', function () {

        it('waitForIssue returns row on first check', async function () {
            const { db, mockConn } = createDb()
            db.sleep = sinon.stub().resolves()

            const mockRow = { tick: 'TOK', status: 'valid' }
            mockConn.query.resolves([mockRow])

            const result = await db.waitForIssue({ tick: 'TOK' }, 5000)

            assert.deepStrictEqual(result, mockRow)
            assert(db.sleep.notCalled, 'should not sleep when first check succeeds')
        })
    })

    describe('Scenario: Eventual success (check fails then succeeds)', function () {

        it('waitForIssue returns row after empty results', async function () {
            const { db, mockConn } = createDb()
            db.sleep = sinon.stub().resolves()

            const mockRow = { tick: 'TOK', status: 'valid' }
            mockConn.query.onFirstCall().resolves([])
            mockConn.query.onSecondCall().resolves([])
            mockConn.query.onThirdCall().resolves([mockRow])

            const result = await db.waitForIssue({ tick: 'TOK' }, 30000)

            assert.deepStrictEqual(result, mockRow)
            assert(db.sleep.callCount >= 2, 'should sleep between retries')
        })
    })

    describe('Scenario: Timeout (check never succeeds)', function () {

        it('waitForIssue returns null after timeMax', async function () {
            const { db, mockConn } = createDb()
            db.sleep = sinon.stub().resolves()
            mockConn.query.resolves([])

            const result = await db.waitForIssue({ tick: 'NONEXISTENT' }, 100)

            assert.strictEqual(result, null)
        })
    })

    describe('Scenario: Error during poll (continues polling)', function () {

        it('waitForIssue continues after query error and returns row', async function () {
            const { db, mockConn } = createDb()
            db.sleep = sinon.stub().resolves()

            const mockRow = { tick: 'TOK', status: 'valid' }
            mockConn.query.onFirstCall().rejects(new Error('temporary error'))
            mockConn.query.onSecondCall().resolves([mockRow])

            const result = await db.waitForIssue({ tick: 'TOK' }, 30000)

            assert.deepStrictEqual(result, mockRow)
            assert(db.sleep.callCount >= 1, 'should sleep after error')
            assert(mockConn.release.callCount >= 1, 'connections released')
        })
    })

    describe('Scenario: Connection released on each poll iteration', function () {

        it('releases connection after each check call', async function () {
            const { db, mockConn } = createDb()
            db.sleep = sinon.stub().resolves()

            const mockRow = { tick: 'TOK', status: 'valid' }
            mockConn.query.onFirstCall().resolves([])
            mockConn.query.onSecondCall().resolves([mockRow])

            await db.waitForIssue({ tick: 'TOK' }, 30000)

            // Each checkIssue call acquires and releases a connection
            assert(mockConn.release.callCount >= 2, 'connection released on each iteration')
        })
    })
})
