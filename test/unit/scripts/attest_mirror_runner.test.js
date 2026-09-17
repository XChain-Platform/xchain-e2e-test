'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const runner = require('../../../scripts/run-attest-mirror')

function fixture () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-mirror-runner-'))
    const driver = path.join(root, 'driver.js')
    const log = path.join(root, 'events.log')
    fs.writeFileSync(driver, [
        "'use strict'",
        "const fs = require('fs')",
        "const path = require('path')",
        "const args = process.argv.slice(2)",
        "const phase = args.shift()",
        "const value = (key) => args[args.indexOf(key) + 1]",
        "const stack = value('--stack')",
        "const leg = value('--leg')",
        "const state = path.join(process.env.FAKE_STATE, stack)",
        "const event = (name) => fs.appendFileSync(process.env.FAKE_LOG, name + ' ' + stack + ' ' + leg + ' ' + args.join(' ') + '\\n')",
        "if (phase === 'up') { fs.writeFileSync(state, leg); event('up') }",
        "if (phase === 'ready') { if (!fs.existsSync(state)) process.exit(31); event('ready') }",
        "if (phase === 'run') { event('run-start'); setTimeout(() => { event('run-end'); process.exit(leg.includes('fail') ? 7 : 0) }, 100) }",
        "if (phase === 'down') { event('down'); if (fs.existsSync(state)) fs.unlinkSync(state) }",
    ].join('\n'))
    for (const relative of [
        path.join('test', 'attestMirror', 'a.test.js'),
        path.join('test', 'attestMirror', 'b.test.js'),
        path.join('test', 'attestMirror', 'barrier_family', 'c.test.js'),
    ]) {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
        fs.writeFileSync(path.join(root, relative), '')
    }
    fs.mkdirSync(path.join(root, 'state'))
    return { root, driver, log, state: path.join(root, 'state') }
}

describe('attest-mirror aggregate runner', function () {
    let savedLog = null
    let savedState = null

    beforeEach(function () {
        savedLog = process.env.FAKE_LOG
        savedState = process.env.FAKE_STATE
    })

    afterEach(function () {
        if (savedLog === undefined) delete process.env.FAKE_LOG
        else process.env.FAKE_LOG = savedLog
        if (savedState === undefined) delete process.env.FAKE_STATE
        else process.env.FAKE_STATE = savedState
    })

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

    it('runs a two-leg aggregate through the CLI and releases both stacks', function () {
        const f = fixture()
        const selected = ['test/attestMirror/at0-anti-wedge.test.js',
            'test/attestMirror/barrier_family/ab4_below_activation.test.js']
        const result = spawnSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'scripts', 'run-attest-mirror.js')], {
            cwd: f.root,
            env: Object.assign({}, process.env, {
                ATTEST_MIRROR_STACK_DRIVER: f.driver,
                ATTEST_MIRROR_CONCURRENCY: '2',
                ATTEST_MIRROR_RUN_ID: 'cli-proof',
                ATTEST_MIRROR_LEGS: selected.join(','),
                FAKE_LOG: f.log,
                FAKE_STATE: f.state,
            }),
            encoding: 'utf8',
        })
        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stdout, /2 legs passed, 0 failed/)
        assert.deepStrictEqual(fs.readdirSync(f.state), [])
        const lines = fs.readFileSync(f.log, 'utf8').trim().split('\n')
        assert.strictEqual(lines.filter((line) => line.startsWith('up ')).length, 2)
        assert.strictEqual(lines.filter((line) => line.startsWith('down ')).length, 2)
    })

    it('requires a lifecycle driver at the npm entry point', function () {
        const result = spawnSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'scripts', 'run-attest-mirror.js')], {
            cwd: path.join(__dirname, '..', '..', '..'), env: Object.assign({}, process.env, { ATTEST_MIRROR_STACK_DRIVER: '' }), encoding: 'utf8',
        })
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /ATTEST_MIRROR_STACK_DRIVER/)
    })
})
