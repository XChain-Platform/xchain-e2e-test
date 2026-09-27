'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { withFalsified, expectRed } = require('../../helpers/anchor_fold/falsify')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const DRIVER = path.join(__dirname, 'af4_unarmed_replay.test.js')
const MOCHA = path.join(ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js')
const ASSERTION_MESSAGE = 'unarmed replay reproduced byte-identical anchor_actions rows'
const FIND = `    assert.strictEqual(replayDigest, firstDigest, '${ASSERTION_MESSAGE}');`
const REPLACE = `    assert.strictEqual(replayDigest.slice(0, -1) + (replayDigest.endsWith('0') ? '1' : '0'), firstDigest, '${ASSERTION_MESSAGE}');`

function readReport(reportFile) {
    try {
        return JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    } catch (_) {
        return null
    }
}

function runDriver() {
    const reportFile = path.join(os.tmpdir(), 'anchor-fold-falsify-' + process.pid + '-' + Date.now() + '.json')
    const args = [MOCHA, '--no-config', '--no-package', '--timeout', '0', '--exit',
        '--reporter', 'json', '--reporter-option', 'output=' + reportFile, DRIVER]
    const child = childProcess.spawnSync(process.execPath, args, {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    })
    const report = readReport(reportFile)
    try { fs.unlinkSync(reportFile) } catch (_) {}
    return { child, report }
}

function runDetails(run) {
    const failures = run.report && run.report.failures
        ? run.report.failures.map((test) => test.fullTitle + ': ' + ((test.err && test.err.message) || ''))
        : []
    return failures.concat(run.child.stdout || '', run.child.stderr || '').filter(Boolean).join('\n')
}

function assertGreen(run) {
    assert.ok(run.report && run.report.stats, 'driver produced no Mocha JSON:\n' + runDetails(run))
    assert.strictEqual(run.child.status, 0, 'driver exited ' + run.child.status + ':\n' + runDetails(run))
    assert.strictEqual(run.report.stats.failures, 0, 'driver reported failures:\n' + runDetails(run))
    assert.strictEqual(run.report.stats.pending, 0, 'driver unexpectedly skipped')
    assert.ok(run.report.stats.passes > 0, 'driver ran no passing test')
}

function skipReason(run) {
    if (!run.report || !run.report.stats || run.report.stats.pending === 0) return null
    assert.strictEqual(run.child.status, 0, 'skipped driver exited ' + run.child.status + ':\n' + runDetails(run))
    assert.strictEqual(run.report.stats.failures, 0, 'skipped driver also failed:\n' + runDetails(run))
    assert.strictEqual(run.report.stats.pending, 1, 'driver skipped an unexpected number of tests')
    const match = String(run.child.stdout || '').match(/Skipping ANCHOR fold unarmed replay:[^\r\n]*/)
    assert.ok(match, 'driver skipped without its printed reason')
    return match[0]
}

async function requireRedDriver() {
    const run = runDriver()
    if (run.child.status === 0) return
    assert.ok(run.report && run.report.stats, 'falsified driver produced no Mocha JSON:\n' + runDetails(run))
    throw new Error(runDetails(run))
}

describe.skip('anchor fold unarmed replay falsification', function () {
    this.timeout(0)

    it('turns a perturbed replay digest red, restores exact bytes, and returns green', async function () {
        const original = fs.readFileSync(DRIVER)
        const baseline = runDriver()
        const reason = skipReason(baseline)
        if (reason) {
            console.log(reason)
            this.skip()
        }
        assertGreen(baseline)

        await withFalsified({ file: DRIVER, find: FIND, replace: REPLACE }, async () => {
            await expectRed(requireRedDriver, new RegExp(ASSERTION_MESSAGE))
        })

        assert.deepStrictEqual(fs.readFileSync(DRIVER), original, 'driver bytes changed after restore')
        assertGreen(runDriver())
    })
})
