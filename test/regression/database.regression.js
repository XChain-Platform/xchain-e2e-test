'use strict'

const assert = require('assert')
const sinon  = require('sinon')

// Inject mock mariadb before requiring Database
const mockMariadb = require('../integration/fixtures/mockMariadb')
const Database    = require('../../src/db')

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMockConnection(queryResult) {
    return {
        query:   sinon.stub().resolves(queryResult !== undefined ? queryResult : []),
        release: sinon.stub().resolves()
    }
}

function makeMockPool(conn) {
    return {
        getConnection: sinon.stub().resolves(conn),
        end:           sinon.stub().resolves()
    }
}

function createDb(queryResult) {
    const conn = makeMockConnection(queryResult)
    const pool = makeMockPool(conn)
    mockMariadb.createPool.returns(pool)
    const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
    db.sleep = sinon.stub().resolves()
    return { db, pool, conn }
}

// ═══════════════════════════════════════════════════════════════════════════
// P0 — Database Polling & Assertions Regression Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('[regression:p0] Database Polling & Assertions', function () {

    afterEach(function () {
        sinon.restore()
    })

    // ── R-DB-001 ─────────────────────────────────────────────────────────

    it('[regression:p0] R-DB-001 — waitForIssue returns matching record on first poll', async function () {
        const issueRow = { action_index: 1, tick: 'MYTOKEN', status: 'valid' }
        const { db } = createDb([issueRow])

        const result = await db.waitForIssue({ tick: 'MYTOKEN', status: 'valid' }, 5000)
        assert.ok(result, 'should return a row')
        assert.strictEqual(result.tick, 'MYTOKEN')
    })

    // ── R-DB-002 ─────────────────────────────────────────────────────────

    it('[regression:p0] R-DB-002 — waitForIssue returns null after timeMax exceeded', async function () {
        const { db } = createDb([])

        const result = await db.waitForIssue({ tick: 'NOEXIST' }, 100)
        assert.strictEqual(result, null)
    })

    // ── R-DB-003 ─────────────────────────────────────────────────────────

    it('[regression:p0] R-DB-003 — waitForSend filters by source, destination, tick', async function () {
        const sendRow = { tick: 'TOK', source: 'addr1', destination: 'addr2', status: 'valid' }
        const { db, conn } = createDb([sendRow])

        const result = await db.waitForSend({
            source: 'addr1', destination: 'addr2', tick: 'TOK', status: 'valid'
        }, 5000)

        assert.ok(result, 'should return a row')
        // Verify parameterized query includes all filter values
        const queryCall = conn.query.firstCall
        const sql = queryCall.args[0]
        const params = queryCall.args[1]
        assert.ok(sql.includes('?'), 'query should use parameterized placeholders')
        assert.ok(params.includes('addr1'), 'params should include source')
        assert.ok(params.includes('addr2'), 'params should include destination')
        assert.ok(params.includes('TOK'), 'params should include tick')
    })

    // ── R-DB-004 ─────────────────────────────────────────────────────────

    it('[regression:p0] R-DB-004 — waitForCredit matches address, tick, amount', async function () {
        const creditRow = { address: 'addr1', tick: 'TOK', amount: '100' }
        const { db } = createDb([creditRow])

        const result = await db.waitForCredit({
            address: 'addr1', tick: 'TOK', amount: '100'
        }, 5000)

        assert.ok(result, 'should return a row')
    })

    // ── R-DB-005 ─────────────────────────────────────────────────────────

    it('[regression:p0] R-DB-005 — waitForDebit matches address, tick, amount', async function () {
        const debitRow = { address: 'addr1', tick: 'TOK', amount: '50' }
        const { db } = createDb([debitRow])

        const result = await db.waitForDebit({
            address: 'addr1', tick: 'TOK', amount: '50'
        }, 5000)

        assert.ok(result, 'should return a row')
    })

    // ── R-DB-006 ─────────────────────────────────────────────────────────

    it('[regression:p0] R-DB-006 — checkIssue builds parameterized SQL with correct placeholders', async function () {
        const { db, conn } = createDb([])

        await db.checkIssue({ source: 'addr1', tick: 'TOK', status: 'valid' })

        assert.ok(conn.query.calledOnce, 'query should be called')
        const sql = conn.query.firstCall.args[0]
        const params = conn.query.firstCall.args[1]

        // Count ? placeholders — should match param count
        const placeholderCount = (sql.match(/\?/g) || []).length
        assert.strictEqual(placeholderCount, params.length,
            'placeholder count must match param count')
    })

    // ── R-DB-007 ─────────────────────────────────────────────────────────

    it('[regression:p0] R-DB-007 — constructor creates pool with connectionLimit=10', function () {
        const { db } = createDb()
        assert.strictEqual(db.connectionPoolParams.connectionLimit, 10)
    })

    // ── R-DB-008 ─────────────────────────────────────────────────────────

    it('[regression:p0] R-DB-008 — getConnection retries on pool failure', async function () {
        const conn = makeMockConnection()
        const pool = makeMockPool(conn)

        // First call fails, second succeeds
        pool.getConnection = sinon.stub()
            .onFirstCall().rejects(new Error('pool exhausted'))
            .onSecondCall().resolves(conn)

        mockMariadb.createPool.returns(pool)
        const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
        db.sleep = sinon.stub().resolves()

        const result = await db.getConnection()
        assert.ok(result, 'should eventually get a connection')
        assert.strictEqual(pool.getConnection.callCount, 2)
    })

    // ── R-DB-009 ─────────────────────────────────────────────────────────

    it('[regression:p0] R-DB-009 — ping executes SELECT 1+1 and returns true', async function () {
        const { db } = createDb([{ '1 + 1': 2 }])
        const result = await db.ping()
        assert.strictEqual(result, true)
    })

    it('[regression:p0] R-DB-009b — ping returns false on empty result', async function () {
        const { db } = createDb([])
        const result = await db.ping()
        assert.strictEqual(result, false)
    })

    // ── Connection release ───────────────────────────────────────────────

    it('[regression:p0] R-DB-006b — connection is released after checkIssue', async function () {
        const { db, conn } = createDb([])

        await db.checkIssue({ tick: 'TOK' })
        assert.ok(conn.release.calledOnce, 'connection should be released')
    })

    // ── isNullOrNullString ───────────────────────────────────────────────

    it('[regression:p0] R-DB-006c — isNullOrNullString correctly identifies null-like values', function () {
        const { db } = createDb()
        assert.strictEqual(db.isNullOrNullString(null), true)
        assert.strictEqual(db.isNullOrNullString(undefined), true)
        assert.strictEqual(db.isNullOrNullString(''), true)
        assert.strictEqual(db.isNullOrNullString('hello'), false)
        assert.strictEqual(db.isNullOrNullString(123), false)
    })

    // ── Null filters are omitted from WHERE ──────────────────────────────

    it('[regression:p0] R-DB-006d — null filter fields are omitted from WHERE clause', async function () {
        const { db, conn } = createDb([])

        await db.checkIssue({ source: null, tick: 'TOK', status: null })

        const params = conn.query.firstCall.args[1]
        assert.strictEqual(params.length, 1, 'only non-null tick should be in params')
        assert.strictEqual(params[0], 'TOK')
    })

    // ── Polling with multiple iterations ─────────────────────────────────

    it('[regression:p0] R-DB-001b — waitForIssue polls multiple times before finding record', async function () {
        const issueRow = { action_index: 1, tick: 'TOK', status: 'valid' }
        const conn = makeMockConnection()
        conn.query = sinon.stub()
            .onFirstCall().resolves([])
            .onSecondCall().resolves([])
            .onThirdCall().resolves([issueRow])

        const pool = makeMockPool(conn)
        mockMariadb.createPool.returns(pool)
        const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
        db.sleep = sinon.stub().resolves()

        const result = await db.waitForIssue({ tick: 'TOK' }, 30000)
        assert.ok(result, 'should eventually find the record')
        assert.ok(conn.query.callCount >= 3, 'should have polled at least 3 times')
    })

    // ── transactionConnection override ───────────────────────────────────

    it('[regression:p0] R-DB-008b — getConnection returns transactionConnection when set', async function () {
        const { db } = createDb()
        const txConn = { query: sinon.stub(), release: sinon.stub() }
        db.transactionConnection = txConn

        const result = await db.getConnection()
        assert.strictEqual(result, txConn)
    })
})
