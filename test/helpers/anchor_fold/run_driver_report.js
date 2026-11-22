'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const MOCHA = path.join(ROOT, '..', 'node_modules', 'mocha', 'bin', 'mocha.js')
let reportSequence = 0

function readReport(reportFile) {
    try {
        return JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    } catch (internal) {
        return null
    }
}

function nextReportFile() {
    reportSequence += 1
    return path.join(os.tmpdir(), 'anchor-fold-driver-' + process.pid + '-' + Date.now() + '-' + reportSequence + '.json')
}

function runMochaDriver(driverFile) {
    const reportFile = nextReportFile()
    const args = [MOCHA, '--no-config', '--no-package', '--timeout', '0', '--exit',
        '--reporter', 'json', '--reporter-option', 'output=' + reportFile, driverFile]
    const child = childProcess.spawnSync(process.execPath, args, {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    })
    const report = readReport(reportFile)
    try { fs.unlinkSync(reportFile) } catch (internal) {}
    return { child, report }
}

function runDetails(run) {
    const failures = run.report && run.report.failures
        ? run.report.failures.map((test) => test.fullTitle + ': ' + ((test.err && test.err.message) || ''))
        : []
    return failures.concat(run.child.stdout || '', run.child.stderr || '').filter(Boolean).join('\n')
}

function assertDriverGreen(run) {
    assert.ok(run.report && run.report.stats, 'driver produced no Mocha JSON:\n' + runDetails(run))
    assert.strictEqual(run.child.status, 0, 'driver exited ' + run.child.status + ':\n' + runDetails(run))
    assert.strictEqual(run.report.stats.failures, 0, 'driver reported failures:\n' + runDetails(run))
    assert.strictEqual(run.report.stats.pending, 0, 'driver unexpectedly skipped')
    assert.ok(run.report.stats.passes > 0, 'driver ran no passing test')
}

function driverSkipReason(run, pattern) {
    if (!run.report || !run.report.stats || run.report.stats.pending === 0) return null
    assert.strictEqual(run.child.status, 0, 'skipped driver exited ' + run.child.status + ':\n' + runDetails(run))
    assert.strictEqual(run.report.stats.failures, 0, 'skipped driver also failed:\n' + runDetails(run))
    assert.strictEqual(run.report.stats.pending, 1, 'driver skipped an unexpected number of tests')
    const match = String(run.child.stdout || '').match(pattern)
    assert.ok(match, 'driver skipped without its printed reason')
    return match[0]
}

module.exports = { runMochaDriver, assertDriverGreen, driverSkipReason }
