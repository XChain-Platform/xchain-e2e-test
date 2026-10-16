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

const { assert, sinon, registerHooks, state } = require('./setup.test')

registerHooks()

describe('_waitFor()', function () {
    it('returns immediately when checkFn returns a row on first call', async function () {
        const row     = { id: 1 }
        const checkFn = sinon.stub().resolves(row)
        const result  = await state.db['_waitFor'](checkFn, {}, 30000)
        assert.deepStrictEqual(result, row)
        assert.ok(checkFn.calledOnce)
        assert.ok(state.db.sleep.notCalled)
    })

    it('returns row after checkFn returns null twice then a row (sleep stubbed)', async function () {
        const row     = { id: 42 }
        const checkFn = sinon.stub()
        checkFn.onCall(0).resolves(null)
        checkFn.onCall(1).resolves(null)
        checkFn.onCall(2).resolves(row)

        const result = await state.db['_waitFor'](checkFn, {}, 30000)
        assert.deepStrictEqual(result, row)
        assert.strictEqual(checkFn.callCount, 3)
        assert.ok(state.db.sleep.callCount >= 2)
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
            const result = await state.db['_waitFor'](checkFn, {}, 30000)
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

        const result = await state.db['_waitFor'](checkFn, {}, 30000)
        assert.deepStrictEqual(result, row)
        assert.strictEqual(checkFn.callCount, 2)
        // sleep should have been called after the error
        assert.ok(state.db.sleep.calledOnce)
    })
})

function registerWaitNoAnswerSendTests(TX) {
    it('throws WAIT_NO_ANSWER when every poll of a real check* query fails', async function () {
        state.mockConnection.query.rejects(new Error("ER_BAD_FIELD_ERROR: Unknown column 'x'"))
        await assert.rejects(state.db.waitForSend({ txHash: TX }, 50), err => {
            assert.strictEqual(err.code, 'WAIT_NO_ANSWER')
            assert.match(err.message, /checkSend: no poll answered/)
            assert.match(err.message, /Unknown column 'x'/)
            assert.match(err.cause.message, /Unknown column 'x'/)
            return true
        })
        assert.ok(state.mockConnection.release.called, 'every failed poll still releases its connection')
    })

    it('still returns null when the database answered "no row"', async function () {
        state.mockConnection.query.resolves([])
        assert.strictEqual(await state.db.waitForSend({ txHash: TX }, 50), null)
    })

    it('returns null once any poll answered, even when later polls failed', async function () {
        state.mockConnection.query.onFirstCall().resolves([])
        state.mockConnection.query.rejects(new Error('ER_CONNECTION_LOST'))
        assert.strictEqual(await state.db.waitForSend({ txHash: TX }, 50), null)
    })
}

function registerWaitNoAnswerScopeTests(TX) {
    it('throws WAIT_NO_ANSWER for a list wait whose list query always fails', async function () {
        state.mockConnection.query.rejects(new Error('ER_NO_SUCH_TABLE'))
        await assert.rejects(state.db.waitForList({ txHash: TX, type: 1, items: ['A'] }, 50),
            err => err.code === 'WAIT_NO_ANSWER')
    })

    it('throws WAIT_NO_ANSWER for a check that only warns on schema drift', async function () {
        state.mockConnection.query.rejects(Object.assign(new Error('no such table'), { code: 'ER_NO_SUCH_TABLE' }))
        await assert.rejects(state.db.waitForAttestationRequestCount({ contractIndex: 1, count: 1 }, 50),
            err => err.code === 'WAIT_NO_ANSWER')
    })

    it('keeps null-on-error for a direct check* call, before and after a strict wait', async function () {
        state.mockConnection.query.rejects(new Error('ER_CONNECTION_LOST'))
        assert.strictEqual(await state.db.checkSend({ txHash: TX }), null)
        await assert.rejects(state.db.waitForSend({ txHash: TX }, 50), err => err.code === 'WAIT_NO_ANSWER')
        assert.strictEqual(await state.db.checkSend({ txHash: TX }), null, 'the wait scope must not leak')
    })

    // Request-scoped, not an instance flag: a direct call whose query fails while a
    // wait's own query is in flight on the same Database still gets null.
    it('keeps null-on-error for a direct check* call that overlaps a wait in flight', async function () {
        // The direct call's query fails first, while the wait's query is still pending.
        state.mockConnection.query.callsFake((sql, values) => new Promise((resolve, reject) => {
            const fail = () => reject(new Error('ER_BAD_FIELD_ERROR'))
            if (values.includes('OVERLAP')) setImmediate(fail)
            else setTimeout(fail, 20)
        }))
        const wait   = state.db.waitForSend({ txHash: TX }, 50)
        const direct = state.db.checkIssue({ tick: 'OVERLAP' })
        const [waitErr, directRow] = await Promise.all([wait.then(() => null, err => err), direct])
        assert.strictEqual(directRow, null)
        assert.ok(waitErr && waitErr.code === 'WAIT_NO_ANSWER', 'the wait itself still refuses')
    })
}

// A failed query and an absent row must not give a wait the same null, or every
// "this row must not exist" assertion passes against a query that never ran.
describe('_waitFor() never-answered vs absent', function () {
    const TX = 'a'.repeat(64)

    // Pace polls at 10ms so a 50ms wait makes a handful of polls, not thousands.
    beforeEach(function () {
        state.db.sleep = () => new Promise(resolve => setTimeout(resolve, 10))
    })

    registerWaitNoAnswerSendTests(TX)
    registerWaitNoAnswerScopeTests(TX)
})

describe('waitForDestroy() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkDestroy function reference', async function () {
        const row        = { id: 10 }
        const stub       = sinon.stub(state.db, '_waitFor').resolves(row)
        const params     = { txHash: 'hash1', tick: 'TICK' }

        const result = await state.db.waitForDestroy(params, 5000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], state.db.checkDestroy)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
        assert.strictEqual(stub.firstCall.args[2], 5000)
    })
})

describe('waitForBatch() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkBatch function reference', async function () {
        const row    = { id: 20 }
        const stub   = sinon.stub(state.db, '_waitFor').resolves(row)
        const params = { txHash: 'hash1', status: 'valid' }

        const result = await state.db.waitForBatch(params, 10000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], state.db.checkBatch)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
        assert.strictEqual(stub.firstCall.args[2], 10000)
    })
})

describe('waitForLink() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkLink function reference', async function () {
        const row    = { id: 30 }
        const stub   = sinon.stub(state.db, '_waitFor').resolves(row)
        const params = { txHash: 'hash1', coin1: 'BTC' }

        const result = await state.db.waitForLink(params, 15000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], state.db.checkLink)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
    })
})

describe('waitForDispenserStatus() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkDispenserStatus function reference', async function () {
        const row    = { id: 99, status: 'open' }
        const stub   = sinon.stub(state.db, '_waitFor').resolves(row)
        const params = { dispenserActionIndex: 7, status: 'open' }

        const result = await state.db.waitForDispenserStatus(params, 20000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], state.db.checkDispenserStatus)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
    })
})

describe('waitForAddressOption() delegation to _waitFor', function () {
    it('delegates to _waitFor with checkAddressOption function reference', async function () {
        const row    = { id: 50 }
        const stub   = sinon.stub(state.db, '_waitFor').resolves(row)
        const params = { txHash: 'hash1', source: 'addr1' }

        const result = await state.db.waitForAddressOption(params, 5000)
        assert.deepStrictEqual(result, row)
        assert.ok(stub.calledOnce)
        assert.strictEqual(stub.firstCall.args[0], state.db.checkAddressOption)
        assert.deepStrictEqual(stub.firstCall.args[1], params)
    })
})

describe('waitForIssue() inline polling', function () {
    it('returns row when checkIssue resolves immediately', async function () {
        const row = { id: 5, tick: 'TICK' }
        sinon.stub(state.db, 'checkIssue').resolves(row)

        const result = await state.db.waitForIssue({ tick: 'TICK' }, 30000)
        assert.deepStrictEqual(result, row)
    })

    it('returns null when checkIssue always returns null and timeout is expired', async function () {
        sinon.stub(state.db, 'checkIssue').resolves(null)

        const nowStub = sinon.stub(Date, 'now')
        nowStub.onCall(0).returns(1000)         // endTime = 1000 + 30000
        nowStub.returns(1000 + 30001)           // already past end on condition check

        try {
            const result = await state.db.waitForIssue({ tick: 'TICK' }, 30000)
            assert.strictEqual(result, null)
        } finally {
            nowStub.restore()
        }
    })

    it('retries on error and returns row on second attempt', async function () {
        const row = { id: 8 }
        const stub = sinon.stub(state.db, 'checkIssue')
        stub.onCall(0).rejects(new Error('transient'))
        stub.onCall(1).resolves(row)

        const result = await state.db.waitForIssue({ tick: 'TICK' }, 30000)
        assert.deepStrictEqual(result, row)
        assert.strictEqual(stub.callCount, 2)
    })
})

describe('waitForSend() inline polling', function () {
    it('returns row when checkSend resolves on first attempt', async function () {
        const row = { id: 9 }
        sinon.stub(state.db, 'checkSend').resolves(row)

        const result = await state.db.waitForSend({ tick: 'TICK' }, 30000)
        assert.deepStrictEqual(result, row)
    })

    it('returns null when timeout exceeded', async function () {
        sinon.stub(state.db, 'checkSend').resolves(null)

        const nowStub = sinon.stub(Date, 'now')
        nowStub.onCall(0).returns(1000)
        nowStub.returns(1000 + 30001)

        try {
            const result = await state.db.waitForSend({ tick: 'TICK' }, 30000)
            assert.strictEqual(result, null)
        } finally {
            nowStub.restore()
        }
    })
})
