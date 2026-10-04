'use strict'

const assert = require('assert')
const {
    teardownOutcome,
    withTeardownOnFailure,
} = require('../../attestMirror/helpers/before_all_teardown')

describe('before-all teardown guard', function () {
    it('returns a successful setup value without running teardown', async function () {
        let teardownCalls = 0
        const guardedSetup = withTeardownOnFailure(async function () {
            return 'ready'
        }, async function () {
            teardownCalls += 1
        })

        assert.strictEqual(await guardedSetup(), 'ready')
        assert.strictEqual(teardownCalls, 0)
    })

    it('runs teardown once and rethrows the same setup error', async function () {
        const setupError = new Error('setup failed')
        let teardownCalls = 0
        const guardedSetup = withTeardownOnFailure(function () {
            throw setupError
        }, async function () {
            teardownCalls += 1
        })

        await assert.rejects(guardedSetup(), (err) => err === setupError)
        assert.strictEqual(teardownCalls, 1)
        assert.strictEqual(teardownOutcome(setupError), 'clean')
    })

    it('uses the mocha-style context for setup and teardown', async function () {
        const setupError = new Error('setup failed')
        const ctx = { suite: 'rail drill' }
        const seenContexts = []
        const guardedSetup = withTeardownOnFailure(function () {
            seenContexts.push(this)
            throw setupError
        }, async function () {
            seenContexts.push(this)
        })

        await assert.rejects(guardedSetup.call(ctx), (err) => err === setupError)
        assert.deepStrictEqual(seenContexts, [ctx, ctx])
    })

    it('reports a teardown failure on the original setup error', async function () {
        const setupError = new Error('venue boot failed')
        const teardownError = new Error('database drop failed')
        const guardedSetup = withTeardownOnFailure(async function () {
            throw setupError
        }, async function () {
            throw teardownError
        })

        await assert.rejects(guardedSetup(), (err) => err === setupError)
        assert.strictEqual(
            setupError.message,
            'venue boot failed; teardown after failed setup also failed: database drop failed',
        )
        assert.strictEqual(teardownOutcome(setupError), 'teardown-failed')
        assert.strictEqual(
            teardownOutcome(new Error(setupError.message)),
            'clean',
        )
        const marker = Object.getOwnPropertySymbols(setupError)[0]
        const markerDescriptor = Object.getOwnPropertyDescriptor(setupError, marker)
        assert.strictEqual(markerDescriptor.enumerable, false)
        assert.strictEqual(markerDescriptor.value, teardownError)
    })

    it('handles an asynchronously rejected setup', async function () {
        const setupError = new Error('late rejection')
        let teardownCalls = 0
        const guardedSetup = withTeardownOnFailure(async function () {
            await Promise.resolve()
            throw setupError
        }, async function () {
            teardownCalls += 1
        })

        await assert.rejects(guardedSetup(), (err) => err === setupError)
        assert.strictEqual(teardownCalls, 1)
    })
})
