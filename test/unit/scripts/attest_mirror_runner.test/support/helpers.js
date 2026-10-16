'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { spawnSync } = require('child_process')

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
    fs.writeFileSync(helper, "'use strict'\nrequire('path')\nmodule.exports = { DEPENDENCY_ROOT: __dirname, REQUIRED_DEPENDENCIES: [] }\n")
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
    return function (internalCommand, args) {
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

const CLI = path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'run-attest-mirror.js')

function runCli (options) {
    return spawnSync(process.execPath, [CLI], Object.assign({ encoding: 'utf8' }, options))
}

function fixtureEnv (f, extra) {
    return Object.assign({}, process.env, {
        ATTEST_MIRROR_STACK_DRIVER: f.driver,
        FAKE_LOG: f.log,
        FAKE_STATE: f.state,
    }, extra)
}

// Saves and restores the env the fake driver reads, around every case.
function restoreFakeEnv () {
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
}

module.exports = {
    ABORT_THRESHOLD, fixture, fakeSpawn, captureStdout, runCli, fixtureEnv, restoreFakeEnv
}
