'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { spawnSync } = require('child_process')

const runner = require('../../../scripts/run-attest-mirror')
const ABORT_THRESHOLD = 3

function fixture () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-mirror-runner-'))
    const driver = path.join(root, 'driver.js')
    const helper = path.join(root, 'wait-attest-mirror-stack.js')
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
        "const failures = JSON.parse(process.env.FAKE_FAILURES || '{}')",
        "const failAt = failures[leg]",
        "const state = path.join(process.env.FAKE_STATE, stack)",
        "const event = (name) => fs.appendFileSync(process.env.FAKE_LOG, name + ' ' + stack + ' ' + leg + ' ' + args.join(' ') + '\\n')",
        "if (phase === 'up') { fs.writeFileSync(state, leg); event('up'); if (failAt === phase) process.exit(11) }",
        "if (phase === 'ready') { if (!fs.existsSync(state)) process.exit(31); event('ready'); if (failAt === phase) process.exit(12) }",
        "if (phase === 'seed') { if (!fs.existsSync(state)) process.exit(32); event('seed'); if (failAt === phase) process.exit(13) }",
        "if (phase === 'run') { event('run-start'); setTimeout(() => { event('run-end'); process.exit(failAt === phase || leg.includes('fail') ? 7 : 0) }, 100) }",
        "if (phase === 'down') { event('down'); if (fs.existsSync(state)) fs.unlinkSync(state) }",
    ].join('\n'))
    fs.writeFileSync(helper, "'use strict'\nrequire('path')\n")
    const legs = [
        path.join('test', 'attestMirror', 'a.test.js'),
        path.join('test', 'attestMirror', 'b.test.js'),
        path.join('test', 'attestMirror', 'barrier_family', 'c.test.js'),
    ]
    for (const relative of legs) {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
        fs.writeFileSync(path.join(root, relative), '')
    }
    fs.mkdirSync(path.join(root, 'state'))
    return { root, driver, helper, legs, log, state: path.join(root, 'state') }
}

function fakeSpawn (failurePhase, events) {
    return function (_command, args) {
        const driverOffset = args[0].endsWith('.js') ? 1 : 0
        const phase = args[driverOffset]
        const phaseArgs = args.slice(driverOffset + 1)
        const value = (key) => phaseArgs[phaseArgs.indexOf(key) + 1]
        const leg = value('--leg')
        events.push({ phase, leg, stack: value('--stack') })
        const child = new EventEmitter()
        setImmediate(() => child.emit('exit', failurePhase(phase, leg) ? 7 : 0, null))
        return child
    }
}

async function captureStdout (action) {
    const originalWrite = process.stdout.write
    let output = ''
    process.stdout.write = function (chunk) {
        output += String(chunk)
        return true
    }
    try {
        return { value: await action(), output }
    } catch (error) {
        error.capturedStdout = output
        throw error
    } finally {
        process.stdout.write = originalWrite
    }
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

    it('refuses a missing readiness dependency before allocating a stack', async function () {
        const f = fixture()
        fs.writeFileSync(f.helper, "'use strict'\nrequire('module-that-is-deliberately-absent')\n")
        let error = null
        try {
            await captureStdout(() => runner.runAll({
                root: f.root, driver: f.driver, legs: [f.legs[0]], concurrency: '1', runId: 'preflight-failure',
                spawn: fakeSpawn(() => false, []),
            }))
        } catch (caught) {
            error = caught
        }
        assert.ok(error)
        assert.match(error.message, /module-that-is-deliberately-absent/)
        assert.match(error.message, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        assert.doesNotMatch(error.capturedStdout, /\[attest-mirror\] allocate/)
    })

    it('refuses when the readiness helper is absent', async function () {
        const f = fixture()
        fs.unlinkSync(f.helper)
        await assert.rejects(runner.runAll({
            root: f.root, driver: f.driver, legs: [f.legs[0]], concurrency: '1', runId: 'missing-helper',
            spawn: fakeSpawn(() => false, []),
        }), /readiness helper does not exist/)
    })

    it('passes preflight silently on a healthy run', async function () {
        const f = fixture()
        const events = []
        const captured = await captureStdout(() => runner.runAll({
            root: f.root, driver: f.driver, legs: [f.legs[0]], concurrency: '1', runId: 'silent-preflight',
            spawn: fakeSpawn(() => false, events),
        }))
        assert.strictEqual(captured.value[0].code, 0)
        assert.strictEqual(captured.output,
            '[attest-mirror] allocate am-silent-preflight-1 slot=0 leg=' + f.legs[0] + '\n' +
            '[attest-mirror] release am-silent-preflight-1 exit=0\n')
    })

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
        const result = spawnSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'scripts', 'run-attest-mirror.js')], {
            cwd: f.root,
            env: Object.assign({}, process.env, {
                ATTEST_MIRROR_STACK_DRIVER: f.driver,
                ATTEST_MIRROR_LEGS: ' , ',
                FAKE_LOG: f.log,
                FAKE_STATE: f.state,
            }),
            encoding: 'utf8',
        })
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /no attest-mirror legs selected/)
        assert.deepStrictEqual(fs.readdirSync(f.state), [])
        assert.strictEqual(fs.existsSync(f.log), false)
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
        assert.match(result.stdout, /2 legs passed, 0 failed; failures by phase: none/)
        assert.deepStrictEqual(fs.readdirSync(f.state), [])
        const lines = fs.readFileSync(f.log, 'utf8').trim().split('\n')
        assert.strictEqual(lines.filter((line) => line.startsWith('up ')).length, 2)
        assert.strictEqual(lines.filter((line) => line.startsWith('down ')).length, 2)
    })

    it('summarizes a mixed run by failure phase', function () {
        const f = fixture()
        const selected = [
            'test/attestMirror/at0-anti-wedge.test.js',
            'test/attestMirror/at1_mirror_finalize.test.js',
            'test/attestMirror/at2-dissemination-determinism.test.js',
        ]
        const failures = {
            [selected[0]]: 'up',
            [selected[1]]: 'seed',
            [selected[2]]: 'run',
        }
        const result = spawnSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'scripts', 'run-attest-mirror.js')], {
            cwd: f.root,
            env: Object.assign({}, process.env, {
                ATTEST_MIRROR_STACK_DRIVER: f.driver,
                ATTEST_MIRROR_CONCURRENCY: '1',
                ATTEST_MIRROR_RUN_ID: 'summary-proof',
                ATTEST_MIRROR_LEGS: selected.join(','),
                FAKE_FAILURES: JSON.stringify(failures),
                FAKE_LOG: f.log,
                FAKE_STATE: f.state,
            }),
            encoding: 'utf8',
        })
        assert.strictEqual(result.status, 3, result.stderr)
        assert.match(result.stdout,
            /0 legs passed, 3 failed; failures by phase: up=1, seed=1, run=1/)
    })

    it('keeps the failed-leg exit code when every failure is at run', function () {
        const f = fixture()
        const selected = [
            'test/attestMirror/at0-anti-wedge.test.js',
            'test/attestMirror/at1_mirror_finalize.test.js',
        ]
        const failures = Object.fromEntries(selected.map((leg) => [leg, 'run']))
        const result = spawnSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'scripts', 'run-attest-mirror.js')], {
            cwd: f.root,
            env: Object.assign({}, process.env, {
                ATTEST_MIRROR_STACK_DRIVER: f.driver,
                ATTEST_MIRROR_CONCURRENCY: '2',
                ATTEST_MIRROR_RUN_ID: 'exit-proof',
                ATTEST_MIRROR_LEGS: selected.join(','),
                FAKE_FAILURES: JSON.stringify(failures),
                FAKE_LOG: f.log,
                FAKE_STATE: f.state,
            }),
            encoding: 'utf8',
        })
        assert.strictEqual(result.status, selected.length, result.stderr)
        assert.match(result.stdout, /0 legs passed, 2 failed; failures by phase: run=2/)
    })

    it('requires a lifecycle driver at the npm entry point', function () {
        const result = spawnSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'scripts', 'run-attest-mirror.js')], {
            cwd: path.join(__dirname, '..', '..', '..'), env: Object.assign({}, process.env, { ATTEST_MIRROR_STACK_DRIVER: '' }), encoding: 'utf8',
        })
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /ATTEST_MIRROR_STACK_DRIVER/)
    })
})
