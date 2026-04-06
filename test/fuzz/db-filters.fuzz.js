'use strict'

// Fuzz tests for all Database check* methods.
// Verifies that no combination of fuzzed filter values causes:
// - Unhandled exceptions (crashes)
// - Connection leaks (release not called)
// - Hangs (infinite loops)
// Each property runs 200 iterations with random filter objects.

const assert = require('assert')
const sinon = require('sinon')
const fc = require('fast-check')

const mockMariadb = require('../integration/fixtures/mockMariadb')
const Database = require('../../src/db')
const gen = require('./fuzz-generators')

// ── Helpers ──────────────────────────────────────────────────────

function makeMockConnection() {
    return {
        query: sinon.stub().resolves([]),
        release: sinon.stub().resolves(),
    }
}

function createDb() {
    const mockConn = makeMockConnection()
    const mockPool = { getConnection: sinon.stub().resolves(mockConn) }
    mockMariadb.createPool.returns(mockPool)
    const db = new Database('localhost', 3306, 'test_db', 'user', 'pass')
    db.sleep = sinon.stub().resolves()
    return { db, mockConn }
}

const FC_PARAMS = { numRuns: 200 }

// ── Generic fuzz property: check* must not crash, must release ───

function fuzzCheckMethod(methodName, filterArb) {
    describe(`Fuzz: ${methodName}`, function () {

        afterEach(function () {
            sinon.restore()
            mockMariadb.createPool.resetHistory()
        })

        it(`survives ${FC_PARAMS.numRuns} random filter objects without crashing`, async function () {
            await fc.assert(fc.asyncProperty(filterArb, async (filterObj) => {
                const { db, mockConn } = createDb()

                // The method must either return a value or return null — never throw unhandled
                const result = await db[methodName](filterObj)
                // Result must be null or an object (row)
                assert(result === null || typeof result === 'object',
                    `${methodName} returned unexpected type: ${typeof result}`)
                // Connection must be released IF a query was attempted.
                // Some methods return null early when all filters are null (no query needed).
                if (mockConn.query.called) {
                    assert(mockConn.release.called,
                        `${methodName} did not release connection after query`)
                }
            }), FC_PARAMS)
        })

        it(`releases connection even when query throws`, async function () {
            await fc.assert(fc.asyncProperty(filterArb, async (filterObj) => {
                const { db, mockConn } = createDb()
                mockConn.query.rejects(new Error('fuzz-induced query error'))

                const result = await db[methodName](filterObj)
                assert.strictEqual(result, null, `${methodName} should return null on query error`)
                // Connection must be released IF a query was attempted
                if (mockConn.query.called) {
                    assert(mockConn.release.called,
                        `${methodName} must release connection after query error`)
                }
            }), FC_PARAMS)
        })

        it(`produces well-formed parameterized SQL (no string interpolation)`, async function () {
            await fc.assert(fc.asyncProperty(filterArb, async (filterObj) => {
                const { db, mockConn } = createDb()

                await db[methodName](filterObj)
                if (mockConn.query.called) {
                    const query = mockConn.query.firstCall.args[0]
                    const params = mockConn.query.firstCall.args[1]
                    if (params && params.length > 0) {
                        const placeholderCount = (query.match(/\?/g) || []).length
                        assert.strictEqual(placeholderCount, params.length,
                            `${methodName}: placeholder count (${placeholderCount}) != param count (${params.length})`)
                    }
                }
            }), FC_PARAMS)
        })
    })
}

// ── Additional filter arbs for methods not in the generators ─────

function filterObjectArb(fieldNames) {
    const entries = fieldNames.map(name =>
        gen.filterFieldArb.map(value => [name, value])
    )
    return fc.tuple(...entries).map(pairs => Object.fromEntries(pairs))
}

const orderMatchFilterArb = filterObjectArb([
    'giveActionIndex', 'getActionIndex', 'giveTick', 'getTick', 'giveAmount', 'getAmount', 'status'
])

const swapFilterArb = filterObjectArb([
    'txHash', 'source', 'giveCoin', 'giveTick', 'giveAmount', 'getCoin',
    'getTick', 'getAmount', 'getAddress', 'expiration', 'status', 'swapStatus'
])

const swapMatchFilterArb = filterObjectArb([
    'giveActionIndex', 'getActionIndex', 'giveTick', 'getTick', 'giveAmount', 'getAmount', 'status'
])

const batchFilterArb = filterObjectArb([
    'txHash', 'source', 'status'
])

const linkFilterArb = filterObjectArb([
    'txHash', 'source', 'coin1', 'coin1ActionIndex', 'coin2', 'coin2ActionIndex', 'status'
])

const coinpayFilterArb = filterObjectArb([
    'txHash', 'obligationActionIndex', 'status'
])

const coinpayObligationFilterArb = filterObjectArb([
    'actionIndex', 'coinpayStatus'
])

const contractFilterArb = filterObjectArb([
    'source', 'txHash', 'status'
])

const executionFilterArb = filterObjectArb([
    'contractIndex', 'caller', 'methodName', 'txHash', 'status'
])

const depositFilterArb = filterObjectArb([
    'source', 'contractIndex', 'tick', 'amount', 'txHash', 'status'
])

const withdrawalFilterArb = filterObjectArb([
    'source', 'contractIndex', 'tick', 'amount', 'txHash', 'status'
])

const stakeFilterArb = filterObjectArb([
    'source', 'tier', 'txHash', 'status'
])

const unstakeFilterArb = filterObjectArb([
    'source', 'tier', 'txHash', 'status'
])

const delegationFilterArb = filterObjectArb([
    'source', 'txHash', 'status'
])

const rewardClaimFilterArb = filterObjectArb([
    'source', 'txHash', 'status'
])

// ── Run fuzz properties for all check* methods ───────────────────

describe('Fuzz — Database Filter Objects', function () {

    // Core action methods (use != null check)
    fuzzCheckMethod('checkIssue', gen.issueFilterArb)
    fuzzCheckMethod('checkSend', gen.sendFilterArb)
    fuzzCheckMethod('checkCredit', gen.creditFilterArb)
    fuzzCheckMethod('checkDebit', gen.debitFilterArb)
    fuzzCheckMethod('checkMint', gen.mintFilterArb)
    fuzzCheckMethod('checkBroadcast', gen.broadcastFilterArb)
    fuzzCheckMethod('checkList', gen.listFilterArb)
    fuzzCheckMethod('checkAirdrop', gen.airdropFilterArb)

    // Dispenser methods (use isNullOrNullString — loose equality)
    fuzzCheckMethod('checkDispenser', gen.dispenserFilterArb)
    fuzzCheckMethod('checkDispense', gen.dispenseFilterArb)
    fuzzCheckMethod('checkDispenserStatus', gen.dispenserStatusFilterArb)

    // Additional action methods
    fuzzCheckMethod('checkAddressOption', gen.addressOptionFilterArb)
    fuzzCheckMethod('checkDestroy', gen.destroyFilterArb)
    fuzzCheckMethod('checkMessage', gen.messageFilterArb)
    fuzzCheckMethod('checkFile', gen.fileFilterArb)
    fuzzCheckMethod('checkSleep', gen.sleepFilterArb)
    fuzzCheckMethod('checkSweep', gen.sweepFilterArb)
    fuzzCheckMethod('checkDividend', gen.dividendFilterArb)
    fuzzCheckMethod('checkCallback', gen.callbackFilterArb)
    fuzzCheckMethod('checkOrder', gen.orderFilterArb)

    // Match/batch/link methods
    fuzzCheckMethod('checkOrderMatch', orderMatchFilterArb)
    fuzzCheckMethod('checkSwap', swapFilterArb)
    fuzzCheckMethod('checkSwapMatch', swapMatchFilterArb)
    fuzzCheckMethod('checkBatch', batchFilterArb)
    fuzzCheckMethod('checkLink', linkFilterArb)

    // Coinpay methods
    fuzzCheckMethod('checkCoinpay', coinpayFilterArb)
    fuzzCheckMethod('checkCoinpayObligation', coinpayObligationFilterArb)

    // VM methods
    fuzzCheckMethod('checkContract', contractFilterArb)
    fuzzCheckMethod('checkExecution', executionFilterArb)
    fuzzCheckMethod('checkDeposit', depositFilterArb)
    fuzzCheckMethod('checkWithdrawal', withdrawalFilterArb)

    // Staking methods
    fuzzCheckMethod('checkStake', stakeFilterArb)
    fuzzCheckMethod('checkUnstake', unstakeFilterArb)
    fuzzCheckMethod('checkDelegation', delegationFilterArb)
    fuzzCheckMethod('checkRewardClaim', rewardClaimFilterArb)
})

// ── Fuzz waitFor* polling with fuzzed timeMax ────────────────────

describe('Fuzz — waitFor* with fuzzed timeMax', function () {

    afterEach(function () {
        sinon.restore()
        mockMariadb.createPool.resetHistory()
    })

    // Use bounded integers only — Infinity/MAX_VALUE with stubbed sleep causes OOM
    const boundedTimeMaxArb = fc.oneof(
        fc.constant(0),
        fc.constant(-1),
        fc.constant(-1000),
        fc.constant(1),
        fc.constant(10),
        fc.constant(100),
        fc.constant(1000),
        fc.constant(NaN),
        fc.integer({ min: -10000, max: 10000 })
    )

    it('waitForIssue never hangs with bounded timeMax values', async function () {
        this.timeout(30000)
        await fc.assert(fc.asyncProperty(boundedTimeMaxArb, async (timeMax) => {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            const result = await db.waitForIssue({ tick: 'TOK' }, timeMax)
            assert(result === null || typeof result === 'object')
        }), { numRuns: 50 })
    })

    it('waitForSend never hangs with bounded timeMax values', async function () {
        this.timeout(30000)
        await fc.assert(fc.asyncProperty(boundedTimeMaxArb, async (timeMax) => {
            const { db, mockConn } = createDb()
            mockConn.query.resolves([])

            const result = await db.waitForSend({ source: 'addr' }, timeMax)
            assert(result === null || typeof result === 'object')
        }), { numRuns: 50 })
    })
})

// ── Fuzz isNullOrNullString with all types ───────────────────────

describe('Fuzz — isNullOrNullString type safety', function () {

    it('never throws for any input type', function () {
        const { db } = createDb()

        fc.assert(fc.property(gen.anyFuzzValue, (value) => {
            // Must never throw — only return true or false
            const result = db.isNullOrNullString(value)
            assert(typeof result === 'boolean',
                `isNullOrNullString returned non-boolean: ${typeof result}`)
        }), { numRuns: 500 })
    })
})
