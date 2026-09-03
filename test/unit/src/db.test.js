// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// mariadb is an ESM package that cannot be require()'d directly. We inject a
// synthetic CJS module into require.cache at the resolved mariadb path before
// requiring db.js so that db.js picks up our mock instead of the real ESM module.

'use strict'

const assert  = require('assert')
const sinon   = require('sinon')
const path    = require('path')
const Module  = require('module')

const mariadbPath = require.resolve('mariadb')

const mockMariadb = {
    createPool: sinon.stub()
}

const mariadbModule = new Module(mariadbPath, module)
mariadbModule.exports = mockMariadb
mariadbModule.loaded  = true
require.cache[mariadbPath] = mariadbModule

// Drop any cached copy of db.js so it is re-evaluated against the mock above.
// db.js resolves the driver when it creates a pool rather than at load time, so
// this line is belt-and-braces, not load-bearing for the mock to take effect;
// test/unit/src/dbDriverBinding.test.js holds that property in place. Without it,
// a test file sorting earlier (mocha loads alphabetically) could still leave
// db.js bound to the real mariadb, so every `new Database()` here would open a
// REAL pool against a dead host and fail on timeouts unrelated to the cause.
delete require.cache[require.resolve('../../../src/db')]

const Database = require('../../../src/db')

let mockPool
let mockConnection
let db

function makeMockConnection(queryResult) {
    return {
        query:   sinon.stub().resolves(queryResult !== undefined ? queryResult : [{ id: 1 }]),
        release: sinon.stub().resolves()
    }
}

function countPlaceholders(sql) {
    return (sql.match(/\?/g) || []).length
}

beforeEach(function () {
    mockConnection = makeMockConnection([{ id: 1 }])
    mockPool = { getConnection: sinon.stub().resolves(mockConnection) }

    // Reset and reconfigure the createPool stub for each test
    mockMariadb.createPool.reset()
    mockMariadb.createPool.returns(mockPool)

    db = new Database('localhost', 3306, 'testdb', 'user', 'pass')
    db.sleep = sinon.stub().resolves()
})

afterEach(function () {
    sinon.restore()
})

describe('isNullOrNullString()', function () {
    it('returns true for null', function () {
        assert.strictEqual(db.isNullOrNullString(null), true)
    })

    it('returns true for undefined', function () {
        assert.strictEqual(db.isNullOrNullString(undefined), true)
    })

    it('returns true for empty string ""', function () {
        assert.strictEqual(db.isNullOrNullString(''), true)
    })

    it('returns true for 0 (due to loose equality: 0 == "")', function () {
        assert.strictEqual(db.isNullOrNullString(0), true)
    })

    it('returns true for false (due to loose equality: false == "")', function () {
        assert.strictEqual(db.isNullOrNullString(false), true)
    })

    it('returns false for "text"', function () {
        assert.strictEqual(db.isNullOrNullString('text'), false)
    })

    it('returns false for " " (single space)', function () {
        assert.strictEqual(db.isNullOrNullString(' '), false)
    })
})

describe('getConnection()', function () {
    it('returns transactionConnection when set', async function () {
        const fakeTxConn = { query: sinon.stub(), release: sinon.stub() }
        db.transactionConnection = fakeTxConn
        const conn = await db.getConnection()
        assert.strictEqual(conn, fakeTxConn)
        assert.ok(!mockPool.getConnection.called, 'pool.getConnection should not be called')
    })

    it('returns pool connection when transactionConnection is null', async function () {
        db.transactionConnection = null
        const conn = await db.getConnection()
        assert.strictEqual(conn, mockConnection)
        assert.ok(mockPool.getConnection.calledOnce)
    })

    it('retries when pool.getConnection() throws once then succeeds', async function () {
        db.transactionConnection = null
        const goodConn = makeMockConnection([{ id: 1 }])
        mockPool.getConnection
            .onFirstCall().rejects(new Error('Connection refused'))
            .onSecondCall().resolves(goodConn)

        const conn = await db.getConnection()
        assert.strictEqual(conn, goodConn)
        assert.strictEqual(mockPool.getConnection.callCount, 2)
    })
})

// A stale venue credential must not make a drill hang: getConnection retrying an
// unreachable pool forever would leave a run that neither ends nor says which
// database it could not reach. These hold the bound and the diagnosis in place.
describe('getConnection() gives up loudly on an unreachable pool', function () {

    it('stops after the attempt cap instead of retrying forever', async function () {
        db.CONNECT_MAX_ATTEMPTS = 4
        mockPool.getConnection.rejects(new Error('ECONNREFUSED'))

        await assert.rejects(() => db.getConnection(), /Can't connect to the indexer database/)
        assert.strictEqual(mockPool.getConnection.callCount, 4, 'stops at the attempt cap')
    })

    it('names host, port, database and user so the stale credential is identifiable', async function () {
        db.CONNECT_MAX_ATTEMPTS = 2
        mockPool.getConnection.rejects(new Error('ECONNREFUSED'))

        const err = await db.getConnection().then(
            () => { throw new Error('expected getConnection to reject') },
            (e) => e
        )
        assert.strictEqual(err.code, 'E2E_DB_UNREACHABLE')
        assert.ok(err.message.includes('localhost:3306/testdb'), 'names host:port/database')
        assert.ok(err.message.includes("user 'user'"), 'names the user')
        assert.ok(err.message.includes('ECONNREFUSED'), 'carries the driver message')
        assert.ok(err.message.includes('2 attempts'), 'says how many attempts it made')
    })

    it('never puts the password in the failure message', async function () {
        db.CONNECT_MAX_ATTEMPTS = 1
        mockPool.getConnection.rejects(new Error('ECONNREFUSED'))

        const err = await db.getConnection().then(
            () => { throw new Error('expected getConnection to reject') },
            (e) => e
        )
        assert.ok(!err.message.includes('pass'), 'the password is not part of the diagnosis')
    })

    it('gives up on the wall clock even while attempts remain', async function () {
        // A host that is simply unreachable burns the driver's acquire timeout per
        // attempt, so the attempt cap alone would let a dead venue run for minutes.
        db.CONNECT_MAX_ATTEMPTS = 1000
        db.CONNECT_BUDGET_MS    = 30000
        mockPool.getConnection.rejects(new Error('ETIMEDOUT'))

        let ticks = 0
        const nowStub = sinon.stub(Date, 'now').callsFake(() => (ticks++) * 12000)
        try {
            await assert.rejects(() => db.getConnection(), /after 3 attempts/)
            assert.strictEqual(mockPool.getConnection.callCount, 3, 'stops once the budget is spent')
        } finally {
            nowStub.restore()
        }
    })

    it('fails on the first attempt when the venue rejects the credentials', async function () {
        // Retrying cannot turn a wrong password into a right one; waiting only delays
        // a message that already contains the answer.
        const denied = Object.assign(new Error('Access denied for user'), {
            code: 'ER_ACCESS_DENIED_ERROR', errno: 1045
        })
        mockPool.getConnection.rejects(denied)

        const err = await db.getConnection().then(
            () => { throw new Error('expected getConnection to reject') },
            (e) => e
        )
        assert.strictEqual(mockPool.getConnection.callCount, 1, 'no retries on a credential rejection')
        assert.ok(db.sleep.notCalled, 'does not sleep before giving up')
        assert.ok(err.message.includes('hub config oracle'), 'points at the config oracle, the real source')
        assert.strictEqual(err.cause, denied)
    })

    it('sees a credential rejection the pool wrapped in its own timeout error', async function () {
        // The pool reports an unusable credential as ER_GET_CONNECTION_TIMEOUT with the
        // real refusal on `cause`. Reading only the outer error would retry a password
        // that can never work, which is the hang this item exists to end.
        const wrapped = Object.assign(new Error('pool failed to retrieve a connection from pool'), {
            code: 'ER_GET_CONNECTION_TIMEOUT', errno: 45028,
            cause: Object.assign(new Error('Access denied for user'), { errno: 1045 })
        })
        mockPool.getConnection.rejects(wrapped)

        await assert.rejects(() => db.getConnection(), /venue rejected these credentials/)
        assert.strictEqual(mockPool.getConnection.callCount, 1, 'no retries once the cause is read')
    })

    it('treats a missing database as fatal too', async function () {
        mockPool.getConnection.rejects(Object.assign(new Error('Unknown database'), { errno: 1049 }))

        await assert.rejects(() => db.getConnection(), /Can't connect to the indexer database/)
        assert.strictEqual(mockPool.getConnection.callCount, 1)
    })

    it('still retries an ordinary transient failure', async function () {
        const goodConn = makeMockConnection([{ id: 1 }])
        mockPool.getConnection.rejects(new Error('ECONNREFUSED'))
        mockPool.getConnection.onCall(3).resolves(goodConn)

        const conn = await db.getConnection()
        assert.strictEqual(conn, goodConn)
        assert.strictEqual(mockPool.getConnection.callCount, 4)
    })

    it('defaults leave a dead venue failing well inside a minute', async function () {
        // The worst case is the budget plus the one attempt that crosses it plus its
        // sleep. The drill's contract is a non-zero exit within a minute, so the
        // defaults have to leave room for a ~10s driver acquire timeout on top.
        const fresh  = new Database('h', 3306, 'd', 'u', 'p')
        const budget = fresh.CONNECT_BUDGET_MS + fresh.CONNECT_RETRY_MS
        assert.ok(budget <= 45000, 'default connect budget is ' + budget + 'ms, too close to a minute')
    })

    it('honours the environment overrides for the budget', async function () {
        const before = process.env.E2E_DB_CONNECT_ATTEMPTS
        process.env.E2E_DB_CONNECT_ATTEMPTS = '2'
        try {
            const fresh = new Database('h', 3306, 'd', 'u', 'p')
            assert.strictEqual(fresh.CONNECT_MAX_ATTEMPTS, 2)
        } finally {
            if (before === undefined) delete process.env.E2E_DB_CONNECT_ATTEMPTS
            else process.env.E2E_DB_CONNECT_ATTEMPTS = before
        }
    })
})

describe('ping() on an unreachable pool', function () {
    it('surfaces the unreachable-database error rather than reporting a plain false', async function () {
        // ping() is the suite's first contact with the venue (initialCheck's
        // service-pings phase). A bare false there says "database down" and loses the
        // host/port/database the operator needs, so the error is allowed through.
        db.CONNECT_MAX_ATTEMPTS = 1
        mockPool.getConnection.rejects(new Error('ECONNREFUSED'))

        await assert.rejects(() => db.ping(), /localhost:3306\/testdb/)
    })
})

describe('ping()', function () {
    it('returns true when query returns rows', async function () {
        mockConnection.query.resolves([{ '1 + 1': 2 }])
        const result = await db.ping()
        assert.strictEqual(result, true)
    })

    it('returns false when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.ping()
        assert.strictEqual(result, false)
    })

    it('returns false when query throws; releases connection', async function () {
        mockConnection.query.rejects(new Error('DB error'))
        const result = await db.ping()
        assert.strictEqual(result, false)
        assert.ok(mockConnection.release.calledOnce)
    })

    it('releases connection on successful query', async function () {
        mockConnection.query.resolves([{ '1 + 1': 2 }])
        await db.ping()
        assert.ok(mockConnection.release.calledOnce)
    })
})

describe('checkIssue()', function () {
    it('all-fields: builds SQL with 9 ? placeholders and correct column aliases', async function () {
        const result = await db.checkIssue({
            source: 'addr1', tick: 'TICK', txHash: 'hash1',
            maxSupply: '1000', maxMint: '100', decimals: 8,
            description: 'desc', mintSupply: '500', status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 9)
        assert.strictEqual(params.length, 9)
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('itick.tick = ?'))
        assert.ok(sql.includes('itx.hash = ?'))
        assert.ok(sql.includes('i.max_supply = ?'))
        assert.ok(sql.includes('ist.status = ?'))
        assert.deepStrictEqual(result, { id: 1 })
    })

    it('single-field: only one WHERE condition when only source passed', async function () {
        await db.checkIssue({ source: 'addr1' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ia.address = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkIssue({ tick: 'TICK' })
        assert.strictEqual(result, null)
    })
})

describe('checkSend()', function () {
    it('all-fields: 7 placeholders with correct aliases', async function () {
        await db.checkSend({
            source: 'addr1', destination: 'addr2', tick: 'TICK',
            amount: '100', txHash: 'hash1', memo: 'memo1', status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 7)
        assert.strictEqual(params.length, 7)
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('ia2.address = ?'))
        assert.ok(sql.includes('im.memo = ?'))
        assert.ok(sql.includes('amount = ?'))
    })

    it('single-field: only destination condition', async function () {
        await db.checkSend({ destination: 'addr2' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ia2.address = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkSend({ tick: 'TICK' })
        assert.strictEqual(result, null)
    })
})

describe('checkCredit()', function () {
    it('all-fields: 5 placeholders including block_index and amount', async function () {
        await db.checkCredit({
            blockIndex: 100, txHash: 'hash1', tick: 'TICK',
            address: 'addr1', amount: '50'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 5)
        assert.strictEqual(params.length, 5)
        assert.ok(sql.includes('tr.block_index = ?'))
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('amount = ?'))
        assert.ok(sql.includes('itick.tick = ?'))
    })

    it('single-field: only txHash condition', async function () {
        await db.checkCredit({ txHash: 'hash1' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('itx.hash = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkCredit({ address: 'addr1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDebit()', function () {
    it('all-fields: 5 placeholders with block_index', async function () {
        await db.checkDebit({
            blockIndex: 100, txHash: 'hash1', tick: 'TICK',
            address: 'addr1', amount: '50'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 5)
        assert.strictEqual(params.length, 5)
        assert.ok(sql.includes('tr.block_index = ?'))
        assert.ok(sql.includes('amount = ?'))
    })

    it('single-field: only address condition', async function () {
        await db.checkDebit({ address: 'addr1' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ia.address = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkDebit({ tick: 'TICK' })
        assert.strictEqual(result, null)
    })
})

describe('checkMint()', function () {
    it('all-fields with non-empty memo: 7 placeholders', async function () {
        await db.checkMint({
            blockIndex: 100, txHash: 'hash1', tick: 'TICK',
            destination: 'addr1', amount: '50', memo: 'mymemo', status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 7)
        assert.strictEqual(params.length, 7)
        assert.ok(sql.includes('im.memo = ?'))
        assert.ok(sql.includes('ia.address = ?'))
    })

    it('memo="" produces IS NULL clause with no extra placeholder', async function () {
        await db.checkMint({ memo: '' })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.ok(sql.includes('im.memo IS NULL'))
        assert.strictEqual(countPlaceholders(sql), 0)
        assert.strictEqual(params.length, 0)
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkMint({ tick: 'TICK' })
        assert.strictEqual(result, null)
    })
})

describe('checkBroadcast()', function () {
    it('all-fields: 9 placeholders with correct aliases', async function () {
        await db.checkBroadcast({
            blockIndex: 100, txHash: 'hash1', source: 'addr1',
            message: 'msg', value: '1.0', fee: '0.001',
            memo: 'memo1', broadcastActionIndex: 5, status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 9)
        assert.strictEqual(params.length, 9)
        assert.ok(sql.includes('b.message = ?'))
        assert.ok(sql.includes('b.broadcast_action_index = ?'))
        assert.ok(sql.includes('b.value = ?'))
        assert.ok(sql.includes('b.fee = ?'))
    })

    it('single-field: only source condition', async function () {
        await db.checkBroadcast({ source: 'addr1' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ia.address = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkBroadcast({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkAirdrop()', function () {
    it('all-fields: 8 placeholders with list_action_index', async function () {
        await db.checkAirdrop({
            blockIndex: 100, txHash: 'hash1', source: 'addr1',
            tick: 'TICK', amount: '50', listActionIndex: 10,
            memo: 'memo1', status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 8)
        assert.strictEqual(params.length, 8)
        assert.ok(sql.includes('a.list_action_index = ?'))
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('a.amount = ?'))
    })

    it('single-field: only tick condition', async function () {
        await db.checkAirdrop({ tick: 'TICK' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('itick.tick = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkAirdrop({ source: 'addr1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDispenser()', function () {
    it('getAddress non-null: adds get_ia.address = ? placeholder (uses isNullOrNullString)', async function () {
        await db.checkDispenser({
            blockIndex: 100, txHash: 'hash1', source: 'addr1',
            giveCoin: 'BTC', giveTick: 'TICK', giveAmount: '100',
            giveEscrow: '50', getCoin: 'LTC', getTick: 'LTICK',
            getAmount: '200', getAddress: 'getaddr', fiatCode: null,
            fiatAmount: null, expiration: null, allowList: null,
            blockList: null, memo: null, status: 'valid'
        })
        const sql = mockConnection.query.firstCall.args[0]
        assert.ok(sql.includes('get_ia.address = ?'))
        assert.ok(!sql.includes('get_ia.address = ias.address'))
    })

    it('when getAddress is null, adds get_ia.address = ias.address clause (no placeholder)', async function () {
        await db.checkDispenser({ txHash: 'hash1', getAddress: null })
        const sql = mockConnection.query.firstCall.args[0]
        assert.ok(sql.includes('get_ia.address = ias.address'))
    })

    it('empty-string getAddress treated as null, uses ias.address clause', async function () {
        await db.checkDispenser({ txHash: 'hash1', getAddress: '' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.ok(sql.includes('get_ia.address = ias.address'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkDispenser({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDispense()', function () {
    it('all-fields: 11 placeholders using isNullOrNullString', async function () {
        await db.checkDispense({
            blockIndex: 100, txHash: 'hash1', source: 'addr1',
            giveCoin: 'BTC', giveTick: 'TICK', giveAmount: '100',
            getCoin: 'LTC', getTick: 'LTICK', getAmount: '200',
            destination: 'dest1', status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 11)
        assert.strictEqual(params.length, 11)
        assert.ok(sql.includes('iad.address = ?'))
        assert.ok(sql.includes('ias.address = ?'))
    })

    it('empty-string source is excluded (treated as null by isNullOrNullString)', async function () {
        await db.checkDispense({ txHash: 'hash1', source: '' })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        // Only txHash should produce a placeholder; source='' is excluded
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.strictEqual(params.length, 1)
        // ias.address still appears in SELECT; check only the WHERE portion
        const wherePart = sql.split('WHERE')[1] || ''
        assert.ok(!wherePart.includes('ias.address'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkDispense({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDispenserStatus()', function () {
    it('returns null immediately when no params provided (w.length === 0)', async function () {
        const result = await db.checkDispenserStatus({})
        assert.strictEqual(result, null)
        assert.ok(!mockConnection.query.called)
    })

    it('builds correct SQL when dispenserActionIndex provided', async function () {
        await db.checkDispenserStatus({ dispenserActionIndex: 5 })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.ok(sql.includes('ds.dispenser_action_index = ?'))
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.deepStrictEqual(params, [5])
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkDispenserStatus({ status: 'open' })
        assert.strictEqual(result, null)
    })
})

describe('checkAddressOption()', function () {
    it('all-fields: 5 placeholders with fee_preference and require_memo', async function () {
        await db.checkAddressOption({
            txHash: 'hash1', source: 'addr1',
            feePreference: 1, requireMemo: 0, status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 5)
        assert.strictEqual(params.length, 5)
        assert.ok(sql.includes('ao.fee_preference = ?'))
        assert.ok(sql.includes('ao.require_memo = ?'))
    })

    it('single-field: only status condition', async function () {
        await db.checkAddressOption({ status: 'valid' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ist.status = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkAddressOption({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkDestroy()', function () {
    it('all-fields: 6 placeholders with tick, amount, memo, status', async function () {
        await db.checkDestroy({
            txHash: 'hash1', source: 'addr1', tick: 'TICK',
            amount: '50', memo: 'memo1', status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 6)
        assert.strictEqual(params.length, 6)
        assert.ok(sql.includes('d.amount = ?'))
        assert.ok(sql.includes('itick.tick = ?'))
        assert.ok(sql.includes('im.memo = ?'))
    })

    it('single-field: only tick condition', async function () {
        await db.checkDestroy({ tick: 'TICK' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('itick.tick = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkDestroy({ source: 'addr1' })
        assert.strictEqual(result, null)
    })
})

describe('checkBatch()', function () {
    it('all-fields: 3 placeholders', async function () {
        await db.checkBatch({ txHash: 'hash1', source: 'addr1', status: 'valid' })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 3)
        assert.strictEqual(params.length, 3)
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('ist.status = ?'))
    })

    it('single-field: only txHash condition', async function () {
        await db.checkBatch({ txHash: 'hash1' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('itx.hash = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkBatch({ status: 'valid' })
        assert.strictEqual(result, null)
    })
})

describe('checkLink()', function () {
    it('all-fields: 7 placeholders with coin1/coin2 aliases', async function () {
        await db.checkLink({
            txHash: 'hash1', source: 'addr1', coin1: 'BTC',
            coin1ActionIndex: 1, coin2: 'LTC', coin2ActionIndex: 2, status: 'valid'
        })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.strictEqual(countPlaceholders(sql), 7)
        assert.strictEqual(params.length, 7)
        assert.ok(sql.includes('ic1.coin = ?'))
        assert.ok(sql.includes('ic2.coin = ?'))
        assert.ok(sql.includes('l.coin1_action_index = ?'))
        assert.ok(sql.includes('l.coin2_action_index = ?'))
    })

    it('single-field: only coin1 condition', async function () {
        await db.checkLink({ coin1: 'BTC' })
        const sql = mockConnection.query.firstCall.args[0]
        assert.strictEqual(countPlaceholders(sql), 1)
        assert.ok(sql.includes('ic1.coin = ?'))
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkLink({ txHash: 'hash1' })
        assert.strictEqual(result, null)
    })
})

describe('checkContract()', function () {
    it('returns null immediately when no params provided (w.length === 0)', async function () {
        const result = await db.checkContract({})
        assert.strictEqual(result, null)
        assert.ok(!mockConnection.query.called)
    })

    it('all-fields: 3 placeholders with source, txHash, status', async function () {
        await db.checkContract({ source: 'addr1', txHash: 'hash1', status: 'valid' })
        const sql    = mockConnection.query.firstCall.args[0]
        const params = mockConnection.query.firstCall.args[1]
        assert.ok(sql.includes('ia.address = ?'))
        assert.ok(sql.includes('itx.hash = ?'))
        assert.ok(sql.includes('ist.status = ?'))
        assert.strictEqual(countPlaceholders(sql), 3)
        assert.strictEqual(params.length, 3)
    })

    it('returns null when query returns empty array', async function () {
        mockConnection.query.resolves([])
        const result = await db.checkContract({ source: 'addr1' })
        assert.strictEqual(result, null)
    })
})

describe('checkList()', function () {
    it('returns the list row when items match for type=2 (address)', async function () {
        const listRow  = { id: 1, action_index: 42, type: 2 }
        const itemRows = [{ item_name: 'addr_a' }, { item_name: 'addr_b' }]

        const conn1 = { query: sinon.stub().resolves([listRow]), release: sinon.stub().resolves() }
        const conn2 = { query: sinon.stub().resolves(itemRows), release: sinon.stub().resolves() }
        mockPool.getConnection.onFirstCall().resolves(conn1)
        mockPool.getConnection.onSecondCall().resolves(conn2)

        const result = await db.checkList({
            txHash: 'hash1', source: 'addr1', type: 2,
            status: 'valid', items: ['addr_a', 'addr_b']
        })

        assert.deepStrictEqual(result, listRow)
    })

    it('returns null when list items count does not match items array', async function () {
        const listRow  = { id: 1, action_index: 42, type: 2 }
        const itemRows = [{ item_name: 'addr_a' }]   // only 1, but items has 2

        const conn1 = { query: sinon.stub().resolves([listRow]), release: sinon.stub().resolves() }
        const conn2 = { query: sinon.stub().resolves(itemRows), release: sinon.stub().resolves() }
        mockPool.getConnection.onFirstCall().resolves(conn1)
        mockPool.getConnection.onSecondCall().resolves(conn2)

        const result = await db.checkList({
            txHash: 'hash1', type: 2, items: ['addr_a', 'addr_b']
        })

        assert.strictEqual(result, null)
    })

    it('returns null when item values mismatch', async function () {
        const listRow  = { id: 1, action_index: 42, type: 2 }
        const itemRows = [{ item_name: 'addr_a' }, { item_name: 'addr_c' }]

        const conn1 = { query: sinon.stub().resolves([listRow]), release: sinon.stub().resolves() }
        const conn2 = { query: sinon.stub().resolves(itemRows), release: sinon.stub().resolves() }
        mockPool.getConnection.onFirstCall().resolves(conn1)
        mockPool.getConnection.onSecondCall().resolves(conn2)

        const result = await db.checkList({
            txHash: 'hash1', type: 2, items: ['addr_a', 'addr_b']
        })

        assert.strictEqual(result, null)
    })

    it('returns null when first query finds no list row', async function () {
        const conn1 = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() }
        mockPool.getConnection.resolves(conn1)

        const result = await db.checkList({ txHash: 'hash1', type: 2, items: ['addr_a'] })
        assert.strictEqual(result, null)
    })

    it('type=1 (tick list) uses index_tickers join in items query', async function () {
        const listRow  = { id: 1, action_index: 42, type: 1 }
        const itemRows = [{ item_name: 'TICK' }]

        const conn1 = { query: sinon.stub().resolves([listRow]), release: sinon.stub().resolves() }
        const conn2 = { query: sinon.stub().resolves(itemRows), release: sinon.stub().resolves() }
        mockPool.getConnection.onFirstCall().resolves(conn1)
        mockPool.getConnection.onSecondCall().resolves(conn2)

        const result = await db.checkList({
            type: 1, items: ['TICK']
        })

        assert.deepStrictEqual(result, listRow)
        const itemSql = conn2.query.firstCall.args[0]
        assert.ok(itemSql.includes('index_tickers'))
    })

    // LIST gained MEMO on the wire and a memo_id column on the lists table, but this
    // checker joined neither, so waitForList({memo}) was a silent no-op: a wrong,
    // dropped or unlinked LIST memo was unobservable end to end.
    describe('memo support', function () {
        function wireOneListRow(listRow, itemRows){
            const conn1 = { query: sinon.stub().resolves([listRow]), release: sinon.stub().resolves() }
            const conn2 = { query: sinon.stub().resolves(itemRows), release: sinon.stub().resolves() }
            mockPool.getConnection.onFirstCall().resolves(conn1)
            mockPool.getConnection.onSecondCall().resolves(conn2)
            return conn1
        }

        it('projects the memo through the index_memos join', async function () {
            const conn1 = wireOneListRow({ id: 1, action_index: 42, type: 1, memo: 'hello' }, [{ item_name: 'TICK' }])

            const result = await db.checkList({ type: 1, items: ['TICK'] })

            const sql = conn1.query.firstCall.args[0]
            assert.ok(sql.includes('LEFT JOIN index_memos im ON im.id = l.memo_id'), 'joins index_memos on l.memo_id')
            assert.ok(sql.includes('im.memo AS memo'), 'projects the memo column')
            assert.strictEqual(result.memo, 'hello')
        })

        it('binds a non-empty memo as an equality filter', async function () {
            const conn1 = wireOneListRow({ id: 1, action_index: 42, type: 1, memo: 'hello' }, [{ item_name: 'TICK' }])

            await db.checkList({ type: 1, memo: 'hello', items: ['TICK'] })

            const [sql, values] = conn1.query.firstCall.args
            assert.ok(sql.includes('im.memo = ?'), 'emits the equality clause')
            assert.ok(values.includes('hello'), 'binds the memo value')
        })

        it('treats an empty memo as the NULL the indexer stores', async function () {
            const conn1 = wireOneListRow({ id: 1, action_index: 42, type: 1, memo: null }, [{ item_name: 'TICK' }])

            await db.checkList({ type: 1, memo: '', items: ['TICK'] })

            const [sql, values] = conn1.query.firstCall.args
            assert.ok(sql.includes('im.memo IS NULL'), 'an empty memo asserts NULL, not an empty string')
            assert.ok(!values.includes(''), 'nothing is bound for the NULL check')
        })

        it('filters listActionIndex against the l alias this query actually declares', async function () {
            const conn1 = wireOneListRow({ id: 1, action_index: 42, type: 1 }, [{ item_name: 'TICK' }])

            await db.checkList({ type: 1, listActionIndex: 7, items: ['TICK'] })

            const [sql, values] = conn1.query.firstCall.args
            assert.ok(sql.includes('l.list_action_index = ?'), 'uses the bound alias')
            assert.ok(!/\bb\.list_action_index\b/.test(sql), 'no unbound b alias')
            assert.ok(values.includes(7))
        })
    })
})

describe('_waitFor()', function () {
    it('returns immediately when checkFn returns a row on first call', async function () {
        const row     = { id: 1 }
        const checkFn = sinon.stub().resolves(row)
        const result  = await db._waitFor(checkFn, {}, 30000)
        assert.deepStrictEqual(result, row)
        assert.ok(checkFn.calledOnce)
        assert.ok(db.sleep.notCalled)
    })

    it('returns row after checkFn returns null twice then a row (sleep stubbed)', async function () {
        const row     = { id: 42 }
        const checkFn = sinon.stub()
        checkFn.onCall(0).resolves(null)
        checkFn.onCall(1).resolves(null)
        checkFn.onCall(2).resolves(row)

        const result = await db._waitFor(checkFn, {}, 30000)
        assert.deepStrictEqual(result, row)
        assert.strictEqual(checkFn.callCount, 3)
        assert.ok(db.sleep.callCount >= 2)
    })

    it('returns null after timeout (Date.now stubbed to expire)', async function () {
        const checkFn = sinon.stub().resolves(null)

        let callCount = 0
        const nowStub = sinon.stub(Date, 'now').callsFake(() => {
            callCount++
            // First call: sets endTime; subsequent calls simulate expiry
            if (callCount === 1) return 1000
            return 1000 + 30001   // past endTime
        })

        try {
            const result = await db._waitFor(checkFn, {}, 30000)
            assert.strictEqual(result, null)
        } finally {
            nowStub.restore()
        }
    })

    it('continues polling when checkFn throws (catches error and retries)', async function () {
        const row     = { id: 7 }
        const checkFn = sinon.stub()
        checkFn.onCall(0).rejects(new Error('Transient DB error'))
        checkFn.onCall(1).resolves(row)

        const result = await db._waitFor(checkFn, {}, 30000)
        assert.deepStrictEqual(result, row)
        assert.strictEqual(checkFn.callCount, 2)
        // sleep should have been called after the error
        assert.ok(db.sleep.calledOnce)
    })
})

describe('waitForDestroy() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkDestroy function reference', async function () {
        const row        = { id: 10 }
        const stub       = sinon.stub(db, '_waitFor').resolves(row)
        const params     = { txHash: 'hash1', tick: 'TICK' }

        const result = await db.waitForDestroy(params, 5000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], db.checkDestroy)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
        assert.strictEqual(stub.firstCall.args[2], 5000)
    })
})

describe('waitForBatch() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkBatch function reference', async function () {
        const row    = { id: 20 }
        const stub   = sinon.stub(db, '_waitFor').resolves(row)
        const params = { txHash: 'hash1', status: 'valid' }

        const result = await db.waitForBatch(params, 10000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], db.checkBatch)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
        assert.strictEqual(stub.firstCall.args[2], 10000)
    })
})

describe('waitForLink() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkLink function reference', async function () {
        const row    = { id: 30 }
        const stub   = sinon.stub(db, '_waitFor').resolves(row)
        const params = { txHash: 'hash1', coin1: 'BTC' }

        const result = await db.waitForLink(params, 15000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], db.checkLink)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
    })
})

describe('waitForDispenserStatus() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkDispenserStatus function reference', async function () {
        const row    = { id: 99, status: 'open' }
        const stub   = sinon.stub(db, '_waitFor').resolves(row)
        const params = { dispenserActionIndex: 7, status: 'open' }

        const result = await db.waitForDispenserStatus(params, 20000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], db.checkDispenserStatus)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
    })
})

describe('waitForAddressOption() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkAddressOption function reference', async function () {
        const row    = { id: 50 }
        const stub   = sinon.stub(db, '_waitFor').resolves(row)
        const params = { txHash: 'hash1', source: 'addr1' }

        const result = await db.waitForAddressOption(params, 5000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], db.checkAddressOption)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
    })
})

describe('waitForIssue() inline polling', function () {
    it('returns row when checkIssue resolves immediately', async function () {
        const row = { id: 5, tick: 'TICK' }
        sinon.stub(db, 'checkIssue').resolves(row)

        const result = await db.waitForIssue({ tick: 'TICK' }, 30000)
        assert.deepStrictEqual(result, row)
    })

    it('returns null when checkIssue always returns null and timeout is expired', async function () {
        sinon.stub(db, 'checkIssue').resolves(null)

        const nowStub = sinon.stub(Date, 'now')
        nowStub.onCall(0).returns(1000)         // endTime = 1000 + 30000
        nowStub.returns(1000 + 30001)           // already past end on condition check

        try {
            const result = await db.waitForIssue({ tick: 'TICK' }, 30000)
            assert.strictEqual(result, null)
        } finally {
            nowStub.restore()
        }
    })

    it('retries on error and returns row on second attempt', async function () {
        const row = { id: 8 }
        const stub = sinon.stub(db, 'checkIssue')
        stub.onCall(0).rejects(new Error('transient'))
        stub.onCall(1).resolves(row)

        const result = await db.waitForIssue({ tick: 'TICK' }, 30000)
        assert.deepStrictEqual(result, row)
        assert.strictEqual(stub.callCount, 2)
    })
})

describe('waitForSend() inline polling', function () {
    it('returns row when checkSend resolves on first attempt', async function () {
        const row = { id: 9 }
        sinon.stub(db, 'checkSend').resolves(row)

        const result = await db.waitForSend({ tick: 'TICK' }, 30000)
        assert.deepStrictEqual(result, row)
    })

    it('returns null when timeout exceeded', async function () {
        sinon.stub(db, 'checkSend').resolves(null)

        const nowStub = sinon.stub(Date, 'now')
        nowStub.onCall(0).returns(1000)
        nowStub.returns(1000 + 30001)

        try {
            const result = await db.waitForSend({ tick: 'TICK' }, 30000)
            assert.strictEqual(result, null)
        } finally {
            nowStub.restore()
        }
    })
})
