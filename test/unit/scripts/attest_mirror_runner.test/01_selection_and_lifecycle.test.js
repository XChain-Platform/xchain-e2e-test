'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const runner = require('../../../../bin/run-attest-mirror')
const { fixture, restoreFakeEnv } = require('./support/helpers')

function registerSelectionTests () {
    it('caps concurrency at three and rejects oversubscription', function () {
        assert.strictEqual(runner.concurrencyFrom(undefined), 3)
        assert.strictEqual(runner.concurrencyFrom('1'), 1)
        assert.throws(() => runner.concurrencyFrom('4'), /integer from 1 to 3/)
        assert.throws(() => runner.concurrencyFrom('0'), /integer from 1 to 3/)
    })

    it('expands the two package-script globs into the complete sorted leg list', function () {
        const f = fixture()
        assert.deepStrictEqual(runner.listLegs(f.root, [
            'test/attestMirror/*.test.js', 'test/attestMirror/barrier_family/*.test.js',
        ]), [
            'test/attestMirror/a.test.js',
            'test/attestMirror/b.test.js',
            'test/attestMirror/barrier_family/c.test.js',
        ])
    })
}

function registerLifecycleTests () {
    it('allocates a unique stack per leg, waits for both readiness gates and tears every stack down', async function () {
        const f = fixture()
        process.env.FAKE_LOG = f.log
        process.env.FAKE_STATE = f.state
        const legs = runner.listLegs(f.root, [])
        const results = await runner.runAll({
            root: f.root, driver: f.driver, legs, concurrency: '2', runId: 'two-leg-proof',
        })
        assert.deepStrictEqual(results.map((result) => result.code), [0, 0, 0])
        const lines = fs.readFileSync(f.log, 'utf8').trim().split('\n')
        const stacks = new Set(lines.filter((line) => line.startsWith('up ')).map((line) => line.split(' ')[1]))
        assert.strictEqual(stacks.size, 3, 'each leg must receive a different stack')
        assert.strictEqual(lines.filter((line) => line.startsWith('down ')).length, 3)
        assert.strictEqual(lines.filter((line) => line.startsWith('seed ')).length, 3)
        assert.deepStrictEqual(fs.readdirSync(f.state), [], 'all stack markers must be removed')
        for (const line of lines.filter((entry) => entry.startsWith('ready '))) {
            assert.match(line, /--require indexer-schema --require miner-health$/)
        }
        const firstEnd = lines.findIndex((line) => line.startsWith('run-end '))
        assert.strictEqual(lines.slice(0, firstEnd).filter((line) => line.startsWith('run-start ')).length, 2,
            'two workers should run while the third waits for a slot')
    })

    it('tears a stack down after its leg fails', async function () {
        const f = fixture()
        const failedLeg = path.join('test', 'attestMirror', 'fail.test.js')
        fs.writeFileSync(path.join(f.root, failedLeg), '')
        process.env.FAKE_LOG = f.log
        process.env.FAKE_STATE = f.state
        const results = await runner.runAll({
            root: f.root, driver: f.driver, legs: [failedLeg], concurrency: '1', runId: 'failure-proof',
        })
        assert.strictEqual(results[0].phase, 'run')
        assert.strictEqual(results[0].code, 7)
        assert.deepStrictEqual(fs.readdirSync(f.state), [])
        assert.match(fs.readFileSync(f.log, 'utf8'), /run-end .*\ndown /)
    })
}

describe('attest-mirror aggregate runner: selection and lifecycle', function () {
    restoreFakeEnv()

    registerSelectionTests()
    registerLifecycleTests()
})
