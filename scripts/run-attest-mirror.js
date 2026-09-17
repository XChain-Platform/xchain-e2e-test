'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const MAX_CONCURRENCY = 3
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

    const runId = String(config.runId || (Date.now().toString(36) + '-' + process.pid))
    assert.ok(/^[a-zA-Z0-9_-]+$/.test(runId), 'ATTEST_MIRROR_RUN_ID contains unsafe characters')
    let next = 0
    const results = []

    async function worker (slot) {
        for (;;) {
            const index = next++
            if (index >= legs.length) return
            const job = { leg: legs[index], slot, stack: 'am-' + runId + '-' + String(index + 1) }
            process.stdout.write('[attest-mirror] allocate ' + job.stack + ' slot=' + slot + ' leg=' + job.leg + '\n')
            const result = await runLeg(driver, job, config)
            results[index] = result
            process.stdout.write('[attest-mirror] release ' + job.stack + ' exit=' + result.code +
                (result.phase ? ' phase=' + result.phase : '') + '\n')
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, legs.length) }, (_, slot) => worker(slot)))
    return results
}

async function main () {
    const driver = process.env.ATTEST_MIRROR_STACK_DRIVER
    assert.ok(driver, 'ATTEST_MIRROR_STACK_DRIVER must name the isolated-stack lifecycle driver')
    const selected = process.env.ATTEST_MIRROR_LEGS
        ? process.env.ATTEST_MIRROR_LEGS.split(',').map((leg) => leg.trim()).filter(Boolean)
        : process.argv.slice(2)
    const results = await runAll({
        root: REPO_ROOT,
        driver,
        legs: selected,
        concurrency: process.env.ATTEST_MIRROR_CONCURRENCY,
        runId: process.env.ATTEST_MIRROR_RUN_ID,
    })
    const failed = results.filter((result) => result.code !== 0)
    process.stdout.write('[attest-mirror] ' + (results.length - failed.length) + ' legs passed, ' + failed.length + ' failed\n')
    if (failed.length > 0) process.exitCode = Math.min(failed.length, 255)
}

module.exports = { MAX_CONCURRENCY, LEG_DIRS, listLegs, concurrencyFrom, driverCommand, runDriver, runLeg, runAll }

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write('[attest-mirror] ' + error.stack + '\n')
        process.exitCode = 1
    })
}
