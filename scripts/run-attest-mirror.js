'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { createRequire } = require('module')

const REPO_ROOT = path.resolve(__dirname, '..')
const MAX_CONCURRENCY = 3
const ENV_FAILURE_ABORT_THRESHOLD = 3
const LEG_DIRS = [
    path.join('test', 'attestMirror'),
    path.join('test', 'attestMirror', 'barrier_family'),
]

function listLegs (root, requested) {
    if (requested.length > 0) {
        const legs = []
        for (const value of requested) {
            const relative = path.normalize(value)
            assert.ok(!path.isAbsolute(relative) && !relative.startsWith('..' + path.sep),
                'attest-mirror leg must be inside the repository: ' + value)
            if (path.basename(relative) === '*.test.js') {
                const dir = path.dirname(relative)
                assert.ok(LEG_DIRS.includes(dir), 'attest-mirror glob is outside the leg directories: ' + value)
                for (const name of fs.readdirSync(path.join(root, dir))) {
                    if (name.endsWith('.test.js')) legs.push(path.join(dir, name))
                }
                continue
            }
            const absolute = path.join(root, relative)
            assert.ok(LEG_DIRS.includes(path.dirname(relative)),
                'attest-mirror leg is outside the leg directories: ' + value)
            assert.ok(fs.statSync(absolute).isFile() && relative.endsWith('.test.js'),
                'attest-mirror leg is not a test file: ' + value)
            legs.push(relative)
        }
        return [...new Set(legs)].sort()
    }

    const legs = []
    for (const dir of LEG_DIRS) {
        for (const name of fs.readdirSync(path.join(root, dir))) {
            if (name.endsWith('.test.js')) legs.push(path.join(dir, name))
        }
    }
    return legs.sort()
}

function concurrencyFrom (raw) {
    const value = raw === undefined || raw === '' ? MAX_CONCURRENCY : Number(raw)
    assert.ok(Number.isInteger(value) && value >= 1 && value <= MAX_CONCURRENCY,
        'ATTEST_MIRROR_CONCURRENCY must be an integer from 1 to ' + MAX_CONCURRENCY)
    return value
}

function driverCommand (driver, args) {
    return path.extname(driver) === '.js'
        ? { command: process.execPath, args: [driver, ...args] }
        : { command: driver, args }
}

function preflightReadinessHelper (driver) {
    const helper = path.join(path.dirname(driver), 'wait-attest-mirror-stack.js')
    assert.ok(fs.existsSync(helper) && fs.statSync(helper).isFile(),
        'attest-mirror readiness helper does not exist: ' + helper)
    const source = fs.readFileSync(helper, 'utf8')
    const requireFromHelper = createRequire(helper)
    const dependencies = new Set()
    const requirePattern = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g
    for (const match of source.matchAll(requirePattern)) dependencies.add(match[2])
    for (const dependency of dependencies) {
        try {
            requireFromHelper.resolve(dependency)
        } catch (error) {
            throw new Error('attest-mirror readiness preflight could not resolve module "' + dependency +
                '" from ' + path.dirname(helper), { cause: error })
        }
    }
}

function runDriver (driver, phase, job, extraArgs, options) {
    const args = [phase, '--stack', job.stack, '--slot', String(job.slot), '--leg', job.leg, ...(extraArgs || [])]
    const invocation = driverCommand(driver, args)
    const spawnFn = (options && options.spawn) || spawn
    const child = spawnFn(invocation.command, invocation.args, {
        cwd: (options && options.root) || REPO_ROOT,
        env: Object.assign({}, process.env, {
            ATTEST_MIRROR_STACK_ID: job.stack,
            ATTEST_MIRROR_SLOT: String(job.slot),
            ATTEST_MIRROR_LEG: job.leg,
        }),
        stdio: 'inherit',
    })
    return new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve(signal ? 128 : (code === null ? 1 : code)))
    })
}

async function runLeg (driver, job, options) {
    let failure = null
    try {
        for (const step of [
            ['up', []],
            ['ready', ['--require', 'indexer-schema', '--require', 'miner-health']],
            ['seed', []],
            ['run', []],
        ]) {
            const code = await runDriver(driver, step[0], job, step[1], options)
            if (code !== 0) {
                failure = { phase: step[0], code }
                break
            }
        }
    } catch (error) {
        failure = { phase: 'spawn', code: 1, error }
    } finally {
        try {
            const code = await runDriver(driver, 'down', job, [], options)
            if (code !== 0 && failure === null) failure = { phase: 'down', code }
        } catch (error) {
            if (failure === null) failure = { phase: 'down', code: 1, error }
        }
    }
    return Object.assign({ leg: job.leg, stack: job.stack }, failure || { phase: null, code: 0 })
}

async function runAll (config) {
    const root = config.root || REPO_ROOT
    const legs = listLegs(root, config.legs || [])
    const concurrency = concurrencyFrom(config.concurrency)
    const driver = path.resolve(root, config.driver)
    assert.ok(fs.existsSync(driver), 'ATTEST_MIRROR_STACK_DRIVER does not exist: ' + driver)
    assert.ok(legs.length > 0, 'no attest-mirror legs selected')
    preflightReadinessHelper(driver)

    const runId = String(config.runId || (Date.now().toString(36) + '-' + process.pid))
    assert.ok(/^[a-zA-Z0-9_-]+$/.test(runId), 'ATTEST_MIRROR_RUN_ID contains unsafe characters')
    let next = 0
    const results = []
    let completedThrough = -1
    let streakPhase = null
    let streakLegs = []
    let abort = null

    function observeCompletedLegs () {
        if (abort) return
        while (results[completedThrough + 1]) {
            const result = results[++completedThrough]
            if (result.code !== 0 && result.phase !== 'run') {
                if (result.phase !== streakPhase) {
                    streakPhase = result.phase
                    streakLegs = []
                }
                streakLegs.push(result.leg)
                if (streakLegs.length >= ENV_FAILURE_ABORT_THRESHOLD) {
                    abort = {
                        phase: streakPhase,
                        legs: streakLegs.slice(-ENV_FAILURE_ABORT_THRESHOLD),
                    }
                    return
                }
            } else {
                streakPhase = null
                streakLegs = []
            }
        }
    }

    async function worker (slot) {
        for (;;) {
            if (abort) return
            const index = next++
            if (index >= legs.length) return
            const job = { leg: legs[index], slot, stack: 'am-' + runId + '-' + String(index + 1) }
            process.stdout.write('[attest-mirror] allocate ' + job.stack + ' slot=' + slot + ' leg=' + job.leg + '\n')
            const result = await runLeg(driver, job, config)
            results[index] = result
            process.stdout.write('[attest-mirror] release ' + job.stack + ' exit=' + result.code +
                (result.phase ? ' phase=' + result.phase : '') + '\n')
            observeCompletedLegs()
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, legs.length) }, (_, slot) => worker(slot)))
    if (abort) {
        throw new Error('attest-mirror abort after ' + ENV_FAILURE_ABORT_THRESHOLD + ' consecutive ' + abort.phase +
            ' failures: ' + abort.legs.join(', '))
    }
    return results
}

async function main () {
    const driver = process.env.ATTEST_MIRROR_STACK_DRIVER
    assert.ok(driver, 'ATTEST_MIRROR_STACK_DRIVER must name the isolated-stack lifecycle driver')
    const selectedFromEnv = process.env.ATTEST_MIRROR_LEGS !== undefined
    const selected = selectedFromEnv
        ? process.env.ATTEST_MIRROR_LEGS.split(',').map((leg) => leg.trim()).filter(Boolean)
        : process.argv.slice(2)
    if (selectedFromEnv) assert.ok(selected.length > 0, 'no attest-mirror legs selected')
    const results = await runAll({
        root: REPO_ROOT,
        driver,
        legs: selected,
        concurrency: process.env.ATTEST_MIRROR_CONCURRENCY,
        runId: process.env.ATTEST_MIRROR_RUN_ID,
    })
    const failed = results.filter((result) => result.code !== 0)
    const failuresByPhase = new Map()
    for (const result of failed) failuresByPhase.set(result.phase, (failuresByPhase.get(result.phase) || 0) + 1)
    const phaseSummary = failuresByPhase.size === 0
        ? 'none'
        : [...failuresByPhase].map(([phase, count]) => phase + '=' + count).join(', ')
    process.stdout.write('[attest-mirror] ' + (results.length - failed.length) + ' legs passed, ' + failed.length +
        ' failed; failures by phase: ' + phaseSummary + '\n')
    if (failed.length > 0) process.exitCode = Math.min(failed.length, 255)
}

module.exports = { MAX_CONCURRENCY, LEG_DIRS, listLegs, concurrencyFrom, driverCommand, runDriver, runLeg, runAll }

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write('[attest-mirror] ' + error.stack + '\n')
        process.exitCode = 1
    })
}
