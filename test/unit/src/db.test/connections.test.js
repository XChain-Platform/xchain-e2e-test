// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const { assert, sinon, Database, makeMockConnection, registerHooks, state } = require('./setup.test')

registerHooks()

describe('isNullOrNullString()', function () {
    it('returns true for null', function () {
        assert.strictEqual(state.db.isNullOrNullString(null), true)
    })

    it('returns true for undefined', function () {
        assert.strictEqual(state.db.isNullOrNullString(undefined), true)
    })

    it('returns true for empty string ""', function () {
        assert.strictEqual(state.db.isNullOrNullString(''), true)
    })

    it('returns true for 0 (due to loose equality: 0 == "")', function () {
        assert.strictEqual(state.db.isNullOrNullString(0), true)
    })

    it('returns true for false (due to loose equality: false == "")', function () {
        assert.strictEqual(state.db.isNullOrNullString(false), true)
    })

    it('returns false for "text"', function () {
        assert.strictEqual(state.db.isNullOrNullString('text'), false)
    })

    it('returns false for " " (single space)', function () {
        assert.strictEqual(state.db.isNullOrNullString(' '), false)
    })
})

describe('getConnection()', function () {
    it('returns transactionConnection when set', async function () {
        const fakeTxConn = { query: sinon.stub(), release: sinon.stub() }
        state.db.transactionConnection = fakeTxConn
        const conn = await state.db.getConnection()
        assert.strictEqual(conn, fakeTxConn)
        assert.ok(!state.mockPool.getConnection.called, 'pool.getConnection should not be called')
    })

    it('returns pool connection when transactionConnection is null', async function () {
        state.db.transactionConnection = null
        const conn = await state.db.getConnection()
        assert.strictEqual(conn, state.mockConnection)
        assert.ok(state.mockPool.getConnection.calledOnce)
    })

    it('retries when pool.getConnection() throws once then succeeds', async function () {
        state.db.transactionConnection = null
        const goodConn = makeMockConnection([{ id: 1 }])
        state.mockPool.getConnection
            .onFirstCall().rejects(new Error('Connection refused'))
            .onSecondCall().resolves(goodConn)

        const conn = await state.db.getConnection()
        assert.strictEqual(conn, goodConn)
        assert.strictEqual(state.mockPool.getConnection.callCount, 2)
    })
})

// A stale venue credential must not make a drill hang: getConnection retrying an
// unreachable pool forever would leave a run that neither ends nor says which
// database it could not reach. These hold the bound and the diagnosis in place.
function registerConnectAttemptCapTests() {
    it('stops after the attempt cap instead of retrying forever', async function () {
        state.db.CONNECT_MAX_ATTEMPTS = 4
        state.mockPool.getConnection.rejects(new Error('ECONNREFUSED'))

        await assert.rejects(() => state.db.getConnection(), /Can't connect to the indexer database/)
        assert.strictEqual(state.mockPool.getConnection.callCount, 4, 'stops at the attempt cap')
    })

    it('names host, port, database and user so the stale credential is identifiable', async function () {
        state.db.CONNECT_MAX_ATTEMPTS = 2
        state.mockPool.getConnection.rejects(new Error('ECONNREFUSED'))

        const err = await state.db.getConnection().then(
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
        state.db.CONNECT_MAX_ATTEMPTS = 1
        state.mockPool.getConnection.rejects(new Error('ECONNREFUSED'))

        const err = await state.db.getConnection().then(
            () => { throw new Error('expected getConnection to reject') },
            (e) => e
        )
        assert.ok(!err.message.includes('pass'), 'the password is not part of the diagnosis')
    })
}

function registerConnectBudgetAndCredentialTests() {
    it('gives up on the wall clock even while attempts remain', async function () {
        // A host that is simply unreachable burns the driver's acquire timeout per
        // attempt, so the attempt cap alone would let a dead venue run for minutes.
        state.db.CONNECT_MAX_ATTEMPTS = 1000
        state.db.CONNECT_BUDGET_MS    = 30000
        state.mockPool.getConnection.rejects(new Error('ETIMEDOUT'))

        let ticks = 0
        const nowStub = sinon.stub(Date, 'now').callsFake(() => (ticks++) * 12000)
        try {
            await assert.rejects(() => state.db.getConnection(), /after 3 attempts/)
            assert.strictEqual(state.mockPool.getConnection.callCount, 3, 'stops once the budget is spent')
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
        state.mockPool.getConnection.rejects(denied)

        const err = await state.db.getConnection().then(
            () => { throw new Error('expected getConnection to reject') },
            (e) => e
        )
        assert.strictEqual(state.mockPool.getConnection.callCount, 1, 'no retries on a credential rejection')
        assert.ok(state.db.sleep.notCalled, 'does not sleep before giving up')
        assert.ok(err.message.includes('_INDEXER_DB_PASS'), 'names the override that fixes it')
        assert.ok(err.message.includes('.env.<code>'), 'names the per-chain file too')
        assert.ok(/hub.*stale|stale.*hub/i.test(err.message), 'says the hub copy is the one that goes stale')
        assert.strictEqual(err.cause, denied)
    })
}

function registerConnectFatalAndTransientTests() {
    it('sees a credential rejection the pool wrapped in its own timeout error', async function () {
        // The pool reports an unusable credential as ER_GET_CONNECTION_TIMEOUT with the
        // real refusal on `cause`. Reading only the outer error would retry a password
        // that can never work, which is the hang this item exists to end.
        const wrapped = Object.assign(new Error('pool failed to retrieve a connection from pool'), {
            code: 'ER_GET_CONNECTION_TIMEOUT', errno: 45028,
            cause: Object.assign(new Error('Access denied for user'), { errno: 1045 })
        })
        state.mockPool.getConnection.rejects(wrapped)

        await assert.rejects(() => state.db.getConnection(), /venue rejected these credentials/)
        assert.strictEqual(state.mockPool.getConnection.callCount, 1, 'no retries once the cause is read')
    })

    it('treats a missing database as fatal too', async function () {
        state.mockPool.getConnection.rejects(Object.assign(new Error('Unknown database'), { errno: 1049 }))

        await assert.rejects(() => state.db.getConnection(), /Can't connect to the indexer database/)
        assert.strictEqual(state.mockPool.getConnection.callCount, 1)
    })

    it('still retries an ordinary transient failure', async function () {
        const goodConn = makeMockConnection([{ id: 1 }])
        state.mockPool.getConnection.rejects(new Error('ECONNREFUSED'))
        state.mockPool.getConnection.onCall(3).resolves(goodConn)

        const conn = await state.db.getConnection()
        assert.strictEqual(conn, goodConn)
        assert.strictEqual(state.mockPool.getConnection.callCount, 4)
    })
}

function registerConnectDefaultsTests() {
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
}

describe('getConnection() gives up loudly on an unreachable pool', function () {
    registerConnectAttemptCapTests()
    registerConnectBudgetAndCredentialTests()
    registerConnectFatalAndTransientTests()
    registerConnectDefaultsTests()
})

describe('adaptive-wait tunable env parsing', function () {
    // `parseInt(env) || default` swallows an explicit "0" because 0 is falsy,
    // silently reinstating the default and undoing a caller's request to
    // disable the wait floor (this is what fixed for WAIT_LAG_BLOCKS
    // alone). These six siblings had the same bug; each case below sets the
    // env var to "0" and asserts the property is really 0, not the default.
    const cases = [
        ['E2E_WAIT_MAX_EXTENSIONS',     'WAIT_MAX_EXTENSIONS'],
        ['E2E_WAIT_LAG_PROBE_MS',       'WAIT_LAG_PROBE_MS'],
        ['E2E_WAIT_MIN_FOR_EXTENSION',  'WAIT_MIN_FOR_EXTENSION'],
        ['E2E_WAIT_PROBE_INTERVAL_MS',  'WAIT_PROBE_INTERVAL_MS'],
        ['E2E_WAIT_PROBE_MIN_MS',       'WAIT_PROBE_MIN_MS'],
        ['E2E_WAIT_WRITE_IDLE_MS',      'WAIT_WRITE_IDLE_MS']
    ]

    for (const [envVar, prop] of cases) {
        it(`honours an explicit 0 for ${envVar} instead of falling back to the default`, function () {
            const before = process.env[envVar]
            process.env[envVar] = '0'
            try {
                const fresh = new Database('h', 3306, 'd', 'u', 'p')
                assert.strictEqual(fresh[prop], 0)
            } finally {
                if (before === undefined) delete process.env[envVar]
                else process.env[envVar] = before
            }
        })

        it(`still falls back to the default for ${envVar} when unset`, function () {
            const before = process.env[envVar]
            delete process.env[envVar]
            try {
                const fresh = new Database('h', 3306, 'd', 'u', 'p')
                assert.ok(Number.isInteger(fresh[prop]) && fresh[prop] > 0,
                    `${prop} should retain a positive default when ${envVar} is unset`)
            } finally {
                if (before === undefined) delete process.env[envVar]
                else process.env[envVar] = before
            }
        })
    }
})

describe('ping() on an unreachable pool', function () {
    it('surfaces the unreachable-database error rather than reporting a plain false', async function () {
        // ping() is the suite's first contact with the venue (initialCheck's
        // service-pings phase). A bare false there says "database down" and loses the
        // host/port/database the operator needs, so the error is allowed through.
        state.db.CONNECT_MAX_ATTEMPTS = 1
        state.mockPool.getConnection.rejects(new Error('ECONNREFUSED'))

        await assert.rejects(() => state.db.ping(), /localhost:3306\/testdb/)
    })
})

describe('ping()', function () {
    it('returns true when query returns rows', async function () {
        state.mockConnection.query.resolves([{ '1 + 1': 2 }])
        const result = await state.db.ping()
        assert.strictEqual(result, true)
    })

    it('returns false when query returns empty array', async function () {
        state.mockConnection.query.resolves([])
        const result = await state.db.ping()
        assert.strictEqual(result, false)
    })

    it('returns false when query throws; releases connection', async function () {
        state.mockConnection.query.rejects(new Error('DB error'))
        const result = await state.db.ping()
        assert.strictEqual(result, false)
        assert.ok(state.mockConnection.release.calledOnce)
    })

    it('releases connection on successful query', async function () {
        state.mockConnection.query.resolves([{ '1 + 1': 2 }])
        await state.db.ping()
        assert.ok(state.mockConnection.release.calledOnce)
    })
})
