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

// Chaos Experiment 5: Database Mid-Query Disconnect (@P1)
//
// Verifies that when a MariaDB connection drops during a polling query,
// the check* methods return null (not throw), release the connection,
// and the waitFor* polling loop continues retrying.

const assert = require('assert')
const sinon = require('sinon')
const { createDb, makeMockConnection, makeMockPool, mockMariadb } = require('./chaos-helpers')

describe('Chaos Experiment 5: Database Mid-Query Disconnect @P1', function () {

    afterEach(function () {
        sinon.restore()
        mockMariadb.createPool.resetHistory()
    })

    describe('checkIssue handles ER_CONNECTION_LOST', function () {

        it('returns null when query throws ER_CONNECTION_LOST', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('ER_CONNECTION_LOST'))

            const result = await db.checkIssue({ tick: 'CHAOS', status: 'valid' })

            assert.strictEqual(result, null)
        })

        it('releases connection even when query throws', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('ER_CONNECTION_LOST'))

            await db.checkIssue({ tick: 'CHAOS' })

            assert(mockConn.release.calledOnce, 'connection must be released in finally block')
        })
    })

    describe('waitForIssue recovers after mid-query disconnect', function () {

        it('returns row after query recovers from disconnect', async function () {
            const { db, mockConn } = createDb()
            const mockRow = { tick: 'CHAOS', status: 'valid' }

            // First poll: disconnect. Second poll: empty. Third poll: success.
            mockConn.query.onFirstCall().rejects(new Error('ER_CONNECTION_LOST'))
            mockConn.query.onSecondCall().resolves([])
            mockConn.query.onThirdCall().resolves([mockRow])

            const result = await db.waitForIssue({ tick: 'CHAOS' }, 30000)

            assert.deepStrictEqual(result, mockRow)
            assert(db.sleep.callCount >= 2, 'should sleep between retries')
        })

        it('returns null when disconnects persist until timeMax', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('ER_CONNECTION_LOST'))

            const result = await db.waitForIssue({ tick: 'CHAOS' }, 100)

            assert.strictEqual(result, null)
            assert(mockConn.release.callCount >= 1, 'connections must be released on each attempt')
        })

        it('releases connection on every poll attempt regardless of outcome', async function () {
            const { db, mockConn } = createDb()
            const mockRow = { tick: 'CHAOS', status: 'valid' }

            mockConn.query.onFirstCall().rejects(new Error('ER_CONNECTION_LOST'))
            mockConn.query.onSecondCall().rejects(new Error('ER_LOCK_WAIT_TIMEOUT'))
            mockConn.query.onThirdCall().resolves([mockRow])

            await db.waitForIssue({ tick: 'CHAOS' }, 30000)

            // Each checkIssue call should release its connection
            assert(mockConn.release.callCount >= 3, 'every poll should release its connection')
        })
    })

    describe('checkSend handles connection drops', function () {

        it('returns null and releases on ER_CONNECTION_LOST', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('ER_CONNECTION_LOST'))

            const result = await db.checkSend({ tick: 'CHAOS', source: 'addr1' })

            assert.strictEqual(result, null)
            assert(mockConn.release.calledOnce)
        })
    })

    describe('different error types during polling', function () {

        it('handles ER_LOCK_WAIT_TIMEOUT gracefully', async function () {
            const { db, mockConn } = createDb()
            const mockRow = { tick: 'CHAOS', status: 'valid' }

            mockConn.query.onFirstCall().rejects(new Error('ER_LOCK_WAIT_TIMEOUT'))
            mockConn.query.onSecondCall().resolves([mockRow])

            const result = await db.waitForIssue({ tick: 'CHAOS' }, 30000)

            assert.deepStrictEqual(result, mockRow)
        })

        it('handles PROTOCOL_CONNECTION_LOST gracefully', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.onFirstCall().rejects(new Error('PROTOCOL_CONNECTION_LOST'))
            mockConn.query.onSecondCall().resolves([{ tick: 'CHAOS', status: 'valid' }])

            const result = await db.waitForIssue({ tick: 'CHAOS' }, 30000)

            assert.ok(result)
            assert.strictEqual(result.tick, 'CHAOS')
        })
    })
})
