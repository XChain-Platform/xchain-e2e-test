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

// Boundary tests for the dynamic WHERE clause construction in check* methods.
// Tests all-null filters, single-field filters, all-fields-populated, empty strings,
// very long strings, and special characters in filter values.

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
    return { db, mockConn, mockPool }
}

function getWhereClause(query) {
    const parts = query.split('WHERE')
    return parts.length > 1 ? parts[1].trim() : ''
}

describe('Boundary — WHERE Clause Construction', function () {

    afterEach(function () {
        sinon.restore()
        mockMariadb.createPool.resetHistory()
    })

    // ── WC-01: checkIssue with all null fields ──────────────────

    describe('WC-01: checkIssue with all filter fields null/undefined', function () {

        it('produces an empty WHERE clause that causes a SQL error, caught gracefully', async function () {
            const { db, mockConn } = createDb()
            // When all fields are null, whereClauses is empty, so JOIN produces "WHERE "
            // which is invalid SQL. The method should catch the error and return null.
            mockConn.query.rejects(new Error('SQL syntax error near WHERE'))

            const result = await db.checkIssue({
                source: null, tick: null, txHash: null, maxSupply: null,
                maxMint: null, decimals: null, description: null, mintSupply: null,
                status: null
            })

            assert.strictEqual(result, null, 'should return null on SQL error')
            assert(mockConn.release.calledOnce, 'connection should be released')
        })
    })

    // ── WC-02: checkIssue with single field ─────────────────────

    describe('WC-02: checkIssue with only tick filter', function () {

        it('builds WHERE clause with single condition', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkIssue({ tick: 'MYTOKEN' })

            const query = mockConn.query.firstCall.args[0]
            const params = mockConn.query.firstCall.args[1]
            const where = getWhereClause(query)

            assert(where.includes('itick.tick = ?'), 'WHERE should contain tick filter')
            assert.deepStrictEqual(params, ['MYTOKEN'])
        })
    })

    // ── WC-03: checkIssue with all fields populated ─────────────

    describe('WC-03: checkIssue with many fields populated', function () {

        it('builds WHERE with multiple AND conditions', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkIssue({
                source: 'addr1',
                tick: 'TOK',
                txHash: 'abc123',
                maxSupply: 1000000,
                maxMint: 1000,
                decimals: 8,
                description: 'test token',
                mintSupply: 500,
                status: 'valid'
            })

            const query = mockConn.query.firstCall.args[0]
            const params = mockConn.query.firstCall.args[1]
            const where = getWhereClause(query)

            assert(where.includes('ia.address = ?'), 'source filter')
            assert(where.includes('itick.tick = ?'), 'tick filter')
            assert(where.includes('itx.hash = ?'), 'txHash filter')
            assert(where.includes('i.max_supply = ?'), 'maxSupply filter')
            assert(where.includes('i.max_mint = ?'), 'maxMint filter')
            assert(where.includes('i.decimals = ?'), 'decimals filter')
            assert(where.includes('i.description = ?'), 'description filter')
            assert(where.includes('i.mint_supply = ?'), 'mintSupply filter')
            assert(where.includes('ist.status = ?'), 'status filter')
            assert.strictEqual(params.length, 9, 'should have 9 parameter values')
        })
    })

    // ── WC-04: checkIssue with empty string values ──────────────

    describe('WC-04: checkIssue with empty string filter values', function () {

        it('includes empty strings as valid filter values (not treated as null)', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkIssue({ tick: '', description: '' })

            const params = mockConn.query.firstCall.args[1]
            const where = getWhereClause(mockConn.query.firstCall.args[0])

            assert(where.includes('itick.tick = ?'), 'empty tick should be included in WHERE')
            assert(where.includes('i.description = ?'), 'empty description should be included')
            assert.deepStrictEqual(params, ['', ''])
        })
    })

    // ── WC-05: checkIssue with very long string values ──────────

    describe('WC-05: checkIssue with very long filter values', function () {

        it('passes long strings as parameterized values without truncation', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])
            const longTick = 'X'.repeat(10000)

            await db.checkIssue({ tick: longTick })

            const params = mockConn.query.firstCall.args[1]
            assert.strictEqual(params[0], longTick, 'value should not be truncated')
            assert.strictEqual(params[0].length, 10000)
        })
    })

    // ── WC-06: checkIssue with special characters (SQL injection safe) ──

    describe('WC-06: checkIssue with SQL-special characters in values', function () {

        it('safely parameterizes values containing SQL metacharacters', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            const malicious = "'; DROP TABLE issues; --"
            await db.checkIssue({ tick: malicious })

            const params = mockConn.query.firstCall.args[1]
            assert.strictEqual(params[0], malicious,
                'parameterized value should be passed as-is (sanitization is driver-level)')
            assert(mockConn.release.calledOnce)
        })
    })

    // ── WC-07: checkSend with all null fields ───────────────────

    describe('WC-07: checkSend with all filter fields null', function () {

        it('returns null gracefully on empty WHERE', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('SQL syntax error'))

            const result = await db.checkSend({
                source: null, destination: null, tick: null,
                amount: null, txHash: null, memo: null, status: null
            })

            assert.strictEqual(result, null)
            assert(mockConn.release.calledOnce)
        })
    })

    // ── WC-08: checkSend with all fields populated ──────────────

    describe('WC-08: checkSend with all fields populated', function () {

        it('builds correct WHERE clause for all send filters', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkSend({
                source: 'src_addr',
                destination: 'dst_addr',
                tick: 'TOK',
                amount: 100,
                txHash: 'hash123',
                memo: 'test memo',
                status: 'valid'
            })

            const query = mockConn.query.firstCall.args[0]
            const params = mockConn.query.firstCall.args[1]
            const where = getWhereClause(query)

            assert(where.includes('ia.address = ?'), 'source')
            assert(where.includes('ia2.address = ?'), 'destination')
            assert(where.includes('itick.tick = ?'), 'tick')
            assert(where.includes('amount = ?'), 'amount')
            assert(where.includes('itx.hash = ?'), 'txHash')
            assert(where.includes('im.memo = ?'), 'memo')
            assert(where.includes('ist.status = ?'), 'status')
            assert.strictEqual(params.length, 7)
        })
    })

    // ── WC-09: checkSend omits null fields, keeps non-null ──────

    describe('WC-09: checkSend mixed null and non-null fields', function () {

        it('includes only non-null fields in WHERE', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkSend({ source: 'addr1', destination: null, tick: 'TOK', memo: null })

            const query = mockConn.query.firstCall.args[0]
            const params = mockConn.query.firstCall.args[1]
            const where = getWhereClause(query)

            assert(where.includes('ia.address = ?'), 'source should be in WHERE')
            assert(where.includes('itick.tick = ?'), 'tick should be in WHERE')
            assert(!where.includes('ia2.address'), 'null destination should be omitted from WHERE')
            assert(!where.includes('im.memo'), 'null memo should be omitted from WHERE')
            assert.deepStrictEqual(params, ['addr1', 'TOK'])
        })
    })

    // ── WC-10: checkCredit with all fields populated ────────────

    describe('WC-10: checkCredit with all fields', function () {

        it('builds correct WHERE for credit filters', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkCredit({
                blockIndex: 100,
                txHash: 'hash456',
                tick: 'TOK',
                address: 'addr1',
                amount: 500
            })

            const params = mockConn.query.firstCall.args[1]
            assert.strictEqual(params.length, 5)
            assert.deepStrictEqual(params, [100, 'hash456', 'TOK', 'addr1', 500])
        })
    })

    // ── WC-11: checkDebit with all fields populated ─────────────

    describe('WC-11: checkDebit with all fields', function () {

        it('builds correct WHERE for debit filters', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkDebit({
                blockIndex: 200,
                txHash: 'hash789',
                tick: 'TOK',
                address: 'addr2',
                amount: 300
            })

            const params = mockConn.query.firstCall.args[1]
            assert.strictEqual(params.length, 5)
            assert.deepStrictEqual(params, [200, 'hash789', 'TOK', 'addr2', 300])
        })
    })

    // ── WC-12: Numeric zero is a valid filter (not null) ────────

    describe('WC-12: Numeric zero treated as valid filter value', function () {

        it('checkIssue includes 0 for maxSupply (not null-skipped)', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkIssue({ maxSupply: 0, decimals: 0 })

            const params = mockConn.query.firstCall.args[1]
            const where = getWhereClause(mockConn.query.firstCall.args[0])

            assert(where.includes('i.max_supply = ?'), 'zero maxSupply should be in WHERE')
            assert(where.includes('i.decimals = ?'), 'zero decimals should be in WHERE')
            assert.deepStrictEqual(params, [0, 0])
        })

        it('checkSend includes 0 for amount (not null-skipped)', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkSend({ amount: 0 })

            const params = mockConn.query.firstCall.args[1]
            assert.deepStrictEqual(params, [0])
        })

        it('checkCredit includes 0 for amount', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkCredit({ amount: 0 })

            const params = mockConn.query.firstCall.args[1]
            assert.deepStrictEqual(params, [0])
        })
    })

    // ── WC-13: Placeholder count matches parameter count ────────

    describe('WC-13: Parameterized query safety — placeholder/value count match', function () {

        it('checkIssue placeholder count matches params for all non-null fields', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkIssue({
                source: 'a', tick: 'b', txHash: 'c', maxSupply: 1,
                maxMint: 2, decimals: 3, description: 'd', mintSupply: 4, status: 'valid'
            })

            const query = mockConn.query.firstCall.args[0]
            const params = mockConn.query.firstCall.args[1]
            const placeholderCount = (query.match(/\?/g) || []).length

            assert.strictEqual(placeholderCount, params.length,
                'number of ? placeholders must match number of parameter values')
        })

        it('checkSend placeholder count matches params', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkSend({
                source: 'a', destination: 'b', tick: 'c',
                amount: 1, txHash: 'd', memo: 'e', status: 'valid'
            })

            const query = mockConn.query.firstCall.args[0]
            const params = mockConn.query.firstCall.args[1]
            const placeholderCount = (query.match(/\?/g) || []).length

            assert.strictEqual(placeholderCount, params.length)
        })

        it('checkCredit placeholder count matches params', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkCredit({
                blockIndex: 1, txHash: 'a', tick: 'b', address: 'c', amount: 100
            })

            const query = mockConn.query.firstCall.args[0]
            const params = mockConn.query.firstCall.args[1]
            const placeholderCount = (query.match(/\?/g) || []).length

            assert.strictEqual(placeholderCount, params.length)
        })

        it('checkDebit placeholder count matches params', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            await db.checkDebit({
                blockIndex: 1, txHash: 'a', tick: 'b', address: 'c', amount: 100
            })

            const query = mockConn.query.firstCall.args[0]
            const params = mockConn.query.firstCall.args[1]
            const placeholderCount = (query.match(/\?/g) || []).length

            assert.strictEqual(placeholderCount, params.length)
        })
    })
})
