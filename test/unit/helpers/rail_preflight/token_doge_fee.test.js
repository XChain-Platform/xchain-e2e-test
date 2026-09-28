'use strict'

const assert = require('assert')

const { withDogeFeeSchedule } = require('../../../helpers/rail_preflight/token_doge_fee')

function fixture(schedules = []){
    const calls = []
    let reads = 0
    const state = {
        dogeRail: { env: {} },
        venue: {
            indexerRpc: async () => {
                const value = schedules[reads++]
                if (value instanceof Error) throw value
                return value
            },
            waitUntil: async (what, predicate, options) => {
                calls.push({ what, options })
                let ready = false
                while (!ready) ready = await predicate()
                return true
            },
        },
    }
    const T = {
        fundDoge: async (...args) => { calls.push({ method: 'fundDoge', args }); return 'funded' },
        dogeAction: async (...args) => { calls.push({ method: 'dogeAction', args }); return 'acted' },
        other: () => 'other',
    }
    return { T, state, calls, reads: () => reads }
}

describe('withDogeFeeSchedule', function () {
    it('pins a named destination before funding with the original arguments', async function () {
        const f = fixture([
            { nativeFeeEnabled: true, feeDestination: '' },
            { nativeFeeEnabled: true, feeDestination: 'DFeeNamed' },
        ])
        const wrapped = withDogeFeeSchedule(f.T, f.state, { timeoutMs: 91, everyMs: 7 })

        assert.strictEqual(await wrapped.fundDoge('DOGE.USER', 3), 'funded')
        assert.strictEqual(f.state.dogeRail.env.FEE_DESTINATION, 'DFeeNamed')
        assert.strictEqual(f.reads(), 2)
        assert.deepStrictEqual(f.calls, [
            { what: 'the DOGE fee schedule to name its destination',
                options: { timeoutMs: 91, everyMs: 7 } },
            { method: 'fundDoge', args: ['DOGE.USER', 3] },
        ])
    })

    it('reuses the successful wait on a second call', async function () {
        const f = fixture([{ nativeFeeEnabled: true, feeDestination: 'DFeeCached' }])
        const wrapped = withDogeFeeSchedule(f.T, f.state)

        await wrapped.fundDoge('FIRST', 1)
        await wrapped.fundDoge('SECOND', 2)

        assert.strictEqual(f.reads(), 1)
    })

    it('waits before a DOGE action', async function () {
        const f = fixture([{ nativeFeeEnabled: true, feeDestination: 'DFeeAction' }])
        const wrapped = withDogeFeeSchedule(f.T, f.state)

        assert.strictEqual(await wrapped.dogeAction('sender', 'wire', 'table'), 'acted')
        assert.strictEqual(f.state.dogeRail.env.FEE_DESTINATION, 'DFeeAction')
        assert.deepStrictEqual(f.calls[1], {
            method: 'dogeAction', args: ['sender', 'wire', 'table'],
        })
    })

    it('retries a thrown fee-schedule read', async function () {
        const f = fixture([
            new Error('not ready'),
            { nativeFeeEnabled: true, feeDestination: 'DFeeAfterError' },
        ])

        await withDogeFeeSchedule(f.T, f.state).fundDoge('RETRY', 1)

        assert.strictEqual(f.reads(), 2)
        assert.strictEqual(f.state.dogeRail.env.FEE_DESTINATION, 'DFeeAfterError')
    })

    it('does not call through after a rejected wait and waits again later', async function () {
        const f = fixture([{ nativeFeeEnabled: true, feeDestination: 'DFeeRetry' }])
        let waits = 0
        f.state.venue.waitUntil = async (what, predicate) => {
            waits += 1
            if (waits === 1) throw new Error('wait failed')
            return predicate()
        }
        const wrapped = withDogeFeeSchedule(f.T, f.state)

        await assert.rejects(wrapped.fundDoge('FAIL', 1), /wait failed/)
        assert.strictEqual(f.calls.some((call) => call.method === 'fundDoge'), false)
        assert.strictEqual(await wrapped.fundDoge('PASS', 2), 'funded')
        assert.strictEqual(waits, 2)
        assert.deepStrictEqual(f.calls, [{ method: 'fundDoge', args: ['PASS', 2] }])
    })

    it('passes every other member through unchanged', function () {
        const f = fixture()
        const wrapped = withDogeFeeSchedule(f.T, f.state)

        assert.notStrictEqual(wrapped, f.T)
        assert.strictEqual(wrapped.other, f.T.other)
    })
})
