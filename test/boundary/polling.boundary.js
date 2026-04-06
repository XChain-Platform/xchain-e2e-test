'use strict'

// Boundary tests for the waitFor* polling pattern in Database, BlockchainConnector,
// and UtxoTracker. Validates behavior at extreme timeMax values (0, negative, 1 ms,
// very large) and verifies no infinite loops or hangs occur.

const assert = require('assert')
const sinon = require('sinon')

// Inject mock mariadb before requiring db.js
const mockMariadb = require('../integration/fixtures/mockMariadb')
const Database = require('../../src/db')
const BlockchainConnector = require('../../src/BlockchainConnector')
const XChainUtxoTrackerConnector = require('../../src/XChainUtxoTrackerConnector')

// ── Helpers ──────────────────────────────────────────────────────

function makeMockConnection(queryResult) {
    return {
        query: sinon.stub().resolves(queryResult !== undefined ? queryResult : []),
        release: sinon.stub().resolves(),
    }
}

function createDb(queryResult) {
    const mockConn = makeMockConnection(queryResult)
    const mockPool = { getConnection: sinon.stub().resolves(mockConn) }
    mockMariadb.createPool.returns(mockPool)
    const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
    db.sleep = sinon.stub().resolves()
    return { db, mockConn, mockPool }
}

describe('Boundary — Polling Timeouts', function () {

    afterEach(function () {
        sinon.restore()
        mockMariadb.createPool.resetHistory()
    })

    // ── PT-01: timeMax = 0 ───────────────────────────────────────

    describe('PT-01: waitForIssue with timeMax = 0', function () {

        it('returns null immediately without executing any poll iterations', async function () {
            const { db, mockConn } = createDb()
            const result = await db.waitForIssue({ tick: 'TOK' }, 0)

            assert.strictEqual(result, null)
            assert.strictEqual(mockConn.query.callCount, 0, 'should not query when timeMax is 0')
            assert.strictEqual(db.sleep.callCount, 0, 'should not sleep when timeMax is 0')
        })
    })

    describe('PT-01b: waitForSend with timeMax = 0', function () {

        it('returns null immediately', async function () {
            const { db, mockConn } = createDb()
            const result = await db.waitForSend({ source: 'addr1' }, 0)

            assert.strictEqual(result, null)
            assert.strictEqual(mockConn.query.callCount, 0)
        })
    })

    describe('PT-01c: waitForCredit with timeMax = 0', function () {

        it('returns null immediately', async function () {
            const { db, mockConn } = createDb()
            const result = await db.waitForCredit({ tick: 'TOK' }, 0)

            assert.strictEqual(result, null)
            assert.strictEqual(mockConn.query.callCount, 0)
        })
    })

    describe('PT-01d: waitForDebit with timeMax = 0', function () {

        it('returns null immediately', async function () {
            const { db, mockConn } = createDb()
            const result = await db.waitForDebit({ tick: 'TOK' }, 0)

            assert.strictEqual(result, null)
            assert.strictEqual(mockConn.query.callCount, 0)
        })
    })

    // ── PT-02: timeMax = 1 (1 ms) ───────────────────────────────

    describe('PT-02: waitForIssue with timeMax = 1', function () {

        it('returns null — does not run indefinitely', async function () {
            const { db, mockConn } = createDb()
            const result = await db.waitForIssue({ tick: 'TOK' }, 1)

            assert.strictEqual(result, null)
            // With stubbed sleep, multiple iterations may complete within 1ms,
            // but the loop must terminate (not hang)
        })
    })

    // ── PT-03: timeMax = -1 (negative) ──────────────────────────

    describe('PT-03: waitForIssue with timeMax = -1', function () {

        it('returns null immediately — endTime is already in the past', async function () {
            const { db, mockConn } = createDb()
            const result = await db.waitForIssue({ tick: 'TOK' }, -1)

            assert.strictEqual(result, null)
            assert.strictEqual(mockConn.query.callCount, 0, 'should not query with negative timeMax')
        })
    })

    describe('PT-03b: waitForSend with timeMax = -1', function () {

        it('returns null immediately', async function () {
            const { db, mockConn } = createDb()
            const result = await db.waitForSend({ source: 'addr1' }, -1)

            assert.strictEqual(result, null)
            assert.strictEqual(mockConn.query.callCount, 0)
        })
    })

    // ── PT-04: record found on last possible iteration ──────────

    describe('PT-04: waitForIssue returns record found just before timeout', function () {

        it('returns the row when found within the time window', async function () {
            const { db, mockConn } = createDb()
            const mockRow = { tick: 'TOK', status: 'valid' }

            // First call returns empty, second returns the row
            mockConn.query.onFirstCall().resolves([])
            mockConn.query.onSecondCall().resolves([mockRow])

            const result = await db.waitForIssue({ tick: 'TOK' }, 30000)

            assert.deepStrictEqual(result, mockRow)
        })
    })

    // ── PT-07: timeMax = Number.MAX_SAFE_INTEGER ────────────────

    describe('PT-07: waitForIssue with very large timeMax', function () {

        it('does not overflow — exits correctly when record is found on first check', async function () {
            const { db, mockConn } = createDb()
            const mockRow = { tick: 'TOK', status: 'valid' }
            mockConn.query.resolves([mockRow])

            const result = await db.waitForIssue({ tick: 'TOK' }, Number.MAX_SAFE_INTEGER)

            assert.deepStrictEqual(result, mockRow)
            assert.strictEqual(mockConn.query.callCount, 1, 'found on first check')
            assert.strictEqual(db.sleep.callCount, 0, 'no sleep needed')
        })
    })

    // ── PT-08: timeMax equals sleep interval ────────────────────

    describe('PT-08: waitForIssue with timeMax = 1000 (equals sleep interval)', function () {

        it('terminates and returns null — does not hang', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            const result = await db.waitForIssue({ tick: 'NONE' }, 1000)

            assert.strictEqual(result, null)
            // With stubbed sleep (instant), multiple iterations execute within 1000ms.
            // The key assertion is that the loop terminates (does not hang).
            assert(mockConn.query.callCount >= 1, 'should execute at least one query')
        })
    })

    // ── BlockchainConnector.waitForTx boundary tests ────────────

    describe('PT-05: BlockchainConnector.waitForTx with timeMax = 0', function () {

        it('returns false immediately', async function () {
            const connector = new BlockchainConnector('localhost', '8333', 'user', 'pass')
            connector.sleep = sinon.stub().resolves()
            connector.getTransactionHex = sinon.stub().rejects(new Error('not found'))

            const result = await connector.waitForTx('abc123', 0)

            assert.strictEqual(result, false)
            assert.strictEqual(connector.getTransactionHex.callCount, 0)
        })
    })

    describe('PT-05b: BlockchainConnector.waitForTx with timeMax = -1', function () {

        it('returns false immediately', async function () {
            const connector = new BlockchainConnector('localhost', '8333', 'user', 'pass')
            connector.sleep = sinon.stub().resolves()
            connector.getTransactionHex = sinon.stub().rejects(new Error('not found'))

            const result = await connector.waitForTx('abc123', -1)

            assert.strictEqual(result, false)
            assert.strictEqual(connector.getTransactionHex.callCount, 0)
        })
    })

    describe('PT-05c: BlockchainConnector.waitForTx returns true on first check', function () {

        it('returns true immediately when tx exists', async function () {
            const connector = new BlockchainConnector('localhost', '8333', 'user', 'pass')
            connector.sleep = sinon.stub().resolves()
            connector.getTransactionHex = sinon.stub().resolves('deadbeef')

            const result = await connector.waitForTx('abc123', 5000)

            assert.strictEqual(result, true)
            assert.strictEqual(connector.getTransactionHex.callCount, 1)
            assert.strictEqual(connector.sleep.callCount, 0)
        })
    })

    // ── UtxoTracker.waitForUtxos boundary tests ─────────────────

    describe('PT-06: UtxoTracker.waitForUtxos with timeMax = 0', function () {

        it('returns false immediately', async function () {
            const tracker = new XChainUtxoTrackerConnector('localhost', '8080')
            tracker.sleep = sinon.stub().resolves()
            tracker.getUtxosFromAddress = sinon.stub().resolves({ utxos: [] })

            const result = await tracker.waitForUtxos('addr1', 0)

            assert.strictEqual(result, false)
            assert.strictEqual(tracker.getUtxosFromAddress.callCount, 0)
        })
    })

    describe('PT-06b: UtxoTracker.waitForUtxos with timeMax = -1', function () {

        it('returns false immediately', async function () {
            const tracker = new XChainUtxoTrackerConnector('localhost', '8080')
            tracker.sleep = sinon.stub().resolves()
            tracker.getUtxosFromAddress = sinon.stub().resolves({ utxos: [] })

            const result = await tracker.waitForUtxos('addr1', -1)

            assert.strictEqual(result, false)
            assert.strictEqual(tracker.getUtxosFromAddress.callCount, 0)
        })
    })

    describe('PT-06c: UtxoTracker.waitForUtxos returns true on first check', function () {

        it('returns true when UTXOs are found immediately', async function () {
            const tracker = new XChainUtxoTrackerConnector('localhost', '8080')
            tracker.sleep = sinon.stub().resolves()
            tracker.getUtxosFromAddress = sinon.stub().resolves({
                utxos: [{ txid: 'abc', vout: 0, value: 10000 }]
            })

            const result = await tracker.waitForUtxos('addr1', 5000)

            assert.strictEqual(result, true)
            assert.strictEqual(tracker.getUtxosFromAddress.callCount, 1)
            assert.strictEqual(tracker.sleep.callCount, 0)
        })
    })

    // ── PT-09: combined — error during zero-timeout poll ────────

    describe('PT-09: waitForIssue with error and timeMax = 0', function () {

        it('returns null without entering error recovery path', async function () {
            const { db, mockConn } = createDb()
            mockConn.query.rejects(new Error('DB exploded'))

            const result = await db.waitForIssue({ tick: 'TOK' }, 0)

            assert.strictEqual(result, null)
            assert.strictEqual(mockConn.query.callCount, 0, 'should never reach query with timeMax=0')
        })
    })
})
