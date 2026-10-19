'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const runner = require('../../../../bin/run-attest-mirror')
const { fakeSpawn, fixture, fixtureEnv, runCli, restoreFakeEnv } = require('./support/helpers')

function registerCliSelectionTests () {
    it('keeps refusing a zero-leg selection', async function () {
        const f = fixture()
        for (const leg of f.legs) fs.unlinkSync(path.join(f.root, leg))
        await assert.rejects(runner.runAll({
            root: f.root, driver: f.driver, legs: [], concurrency: '1', runId: 'zero-legs',
            spawn: fakeSpawn(() => false, []),
        }), /no attest-mirror legs selected/)
    })

    it('refuses an explicit empty CLI selection before allocating a stack', function () {
        const f = fixture()
        const result = runCli({
            cwd: f.root,
            env: fixtureEnv(f, {
                ATTEST_MIRROR_LEGS: ' , ',
            }),
        })
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /no attest-mirror legs selected/)
        assert.deepStrictEqual(fs.readdirSync(f.state), [])
        assert.strictEqual(fs.existsSync(f.log), false)
    })

    it('runs a two-leg aggregate through the CLI and releases both stacks', function () {
        const f = fixture()
        const selected = ['test/attestMirror/at0_anti_wedge.test.js',
            'test/attestMirror/barrier_family/ab4_below_activation.test.js']
        const result = runCli({
            cwd: f.root,
            env: fixtureEnv(f, {
                ATTEST_MIRROR_CONCURRENCY: '2',
                ATTEST_MIRROR_RUN_ID: 'cli-proof',
                ATTEST_MIRROR_LEGS: selected.join(','),
            }),
        })
        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stdout, /2 legs passed, 0 failed; failures by phase: none/)
        assert.deepStrictEqual(fs.readdirSync(f.state), [])
        const lines = fs.readFileSync(f.log, 'utf8').trim().split('\n')
        assert.strictEqual(lines.filter((line) => line.startsWith('up ')).length, 2)
        assert.strictEqual(lines.filter((line) => line.startsWith('down ')).length, 2)
    })
}

function registerCliSummaryTests () {
    it('summarizes a mixed run by failure phase', function () {
        const f = fixture()
        const selected = [
            'test/attestMirror/at0_anti_wedge.test.js',
            'test/attestMirror/at1_mirror_finalize.test.js',
            'test/attestMirror/at2_dissemination_determinism.test.js',
        ]
        const failures = {
            [selected[0]]: 'up',
            [selected[1]]: 'seed',
            [selected[2]]: 'run',
        }
        const result = runCli({
            cwd: f.root,
            env: fixtureEnv(f, {
                ATTEST_MIRROR_CONCURRENCY: '1',
                ATTEST_MIRROR_RUN_ID: 'summary-proof',
                ATTEST_MIRROR_LEGS: selected.join(','),
                FAKE_FAILURES: JSON.stringify(failures),
            }),
        })
        assert.strictEqual(result.status, 3, result.stderr)
        assert.match(result.stdout,
            /0 legs passed, 3 failed; failures by phase: up=1, seed=1, run=1/)
    })

    it('keeps the failed-leg exit code when every failure is at run', function () {
        const f = fixture()
        const selected = [
            'test/attestMirror/at0_anti_wedge.test.js',
            'test/attestMirror/at1_mirror_finalize.test.js',
        ]
        const failures = Object.fromEntries(selected.map((leg) => [leg, 'run']))
        const result = runCli({
            cwd: f.root,
            env: fixtureEnv(f, {
                ATTEST_MIRROR_CONCURRENCY: '2',
                ATTEST_MIRROR_RUN_ID: 'exit-proof',
                ATTEST_MIRROR_LEGS: selected.join(','),
                FAKE_FAILURES: JSON.stringify(failures),
            }),
        })
        assert.strictEqual(result.status, selected.length, result.stderr)
        assert.match(result.stdout, /0 legs passed, 2 failed; failures by phase: run=2/)
    })

    it('requires a lifecycle driver at the npm entry point', function () {
        const result = runCli({
            cwd: path.join(__dirname, '..', '..', '..', '..'), env: Object.assign({}, process.env, { ATTEST_MIRROR_STACK_DRIVER: '' }),
        })
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /ATTEST_MIRROR_STACK_DRIVER/)
    })
}

describe('attest-mirror aggregate runner: cli', function () {
    restoreFakeEnv()

    registerCliSelectionTests()
    registerCliSummaryTests()
})
