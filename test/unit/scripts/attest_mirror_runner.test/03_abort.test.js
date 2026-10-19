'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const runner = require('../../../../bin/run-attest-mirror')
const { ABORT_THRESHOLD, fakeSpawn, fixture, restoreFakeEnv } = require('./support/helpers')

function registerAbortTests () {
    it('aborts after consecutive ready failures and names the phase and legs', async function () {
        const f = fixture()
        const unallocated = [
            path.join('test', 'attestMirror', 'd.test.js'),
            path.join('test', 'attestMirror', 'e.test.js'),
        ]
        for (const leg of unallocated) fs.writeFileSync(path.join(f.root, leg), '')
        const legs = [...f.legs, ...unallocated]
        const events = []
        let error = null
        try {
            await runner.runAll({
                root: f.root, driver: f.driver, legs, concurrency: '1', runId: 'ready-abort',
                spawn: fakeSpawn((phase) => phase === 'ready', events),
            })
        } catch (caught) {
            error = caught
        }
        assert.ok(error)
        assert.match(error.message, new RegExp('abort after ' + ABORT_THRESHOLD + ' consecutive ready failures'))
        for (const leg of f.legs) assert.match(error.message, new RegExp(leg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        assert.strictEqual(events.filter((event) => event.phase === 'up').length, ABORT_THRESHOLD)
        for (const leg of unallocated) assert.doesNotMatch(error.message, new RegExp(leg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    })

    it('does not abort on consecutive run failures and runs every leg', async function () {
        const f = fixture()
        const events = []
        const results = await runner.runAll({
            root: f.root, driver: f.driver, legs: f.legs, concurrency: '2', runId: 'ordinary-red',
            spawn: fakeSpawn((phase) => phase === 'run', events),
        })
        assert.strictEqual(results.length, f.legs.length)
        assert.deepStrictEqual(results.map((result) => result.phase), f.legs.map(() => 'run'))
        assert.strictEqual(events.filter((event) => event.phase === 'run').length, f.legs.length)
    })

    it('tears down every allocated stack when the environment threshold aborts', async function () {
        const f = fixture()
        const events = []
        await assert.rejects(runner.runAll({
            root: f.root, driver: f.driver, legs: f.legs, concurrency: '3', runId: 'abort-teardown',
            spawn: fakeSpawn((phase) => phase === 'ready', events),
        }), /consecutive ready failures/)
        const allocated = events.filter((event) => event.phase === 'up').map((event) => event.stack).sort()
        const tornDown = events.filter((event) => event.phase === 'down').map((event) => event.stack).sort()
        assert.deepStrictEqual(tornDown, allocated)
    })
}

describe('attest-mirror aggregate runner: abort', function () {
    restoreFakeEnv()

    registerAbortTests()
})
