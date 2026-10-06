'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO_ROOT = path.join(__dirname, '../../..')
const SCRIPT = path.join(REPO_ROOT, 'scripts/rail-verdict.js')
const ALPHA = 'test/rail/alpha.rail.test.js'
const BETA = 'test/rail/beta.rail.test.js'

function testCase(title, file, extra = {}) {
    return {
        title,
        fullTitle: 'rail ' + title,
        file,
        duration: 1,
        ...extra
    }
}

function report(passes, pending = [], failures = []) {
    return {
        stats: { passes: passes.length, pending: pending.length, failures: failures.length },
        tests: [...passes, ...pending, ...failures],
        pending,
        failures,
        passes
    }
}

let tempDir

beforeEach(function () {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-verdict-'))
})

afterEach(function () {
    fs.rmSync(tempDir, { recursive: true, force: true })
})

function run(value, files, raw = false) {
    const reportPath = path.join(tempDir, 'report.json')
    if (value !== null) {
        fs.writeFileSync(reportPath, raw ? value : JSON.stringify(value))
    }
    return spawnSync(process.execPath, [SCRIPT, reportPath, ...files], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
    })
}

function assertResult(result, status, lines) {
    assert.strictEqual(result.status, status)
    assert.strictEqual(result.signal, null)
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(result.stdout, lines.join('\n') + '\n')
}

describe('rail verdict passing reports', function () {
    it('passes when every named drive file has a passing case', function () {
        const value = report([
            testCase('alpha passes', '/checkout/' + ALPHA),
            testCase('beta passes', 'C:\\checkout\\' + BETA.replace(/\//g, '\\'))
        ])
        const result = run(value, ['./' + ALPHA, BETA])

        assertResult(result, 0, [
            JSON.stringify(value.stats),
            'RAIL VERDICT PASS 2 passing, 0 failing, 0 skipped across 2 drive file(s): ' +
                ALPHA + ', ' + BETA
        ])
    })

    it('fails the all-pending 35-case trap', function () {
        const pending = Array.from({ length: 35 }, (internal, index) =>
            testCase('pending case ' + (index + 1), '/checkout/' + ALPHA))
        const value = report([], pending)
        const result = run(value, [ALPHA])

        assertResult(result, 1, [
            JSON.stringify(value.stats),
            'RAIL VERDICT FAIL 35 skipped in a drive file: ' +
                pending.map((entry) => entry.title).join('; ')
        ])
    })
})

describe('rail verdict failing cases', function () {
    it('prints a test failure and only the first message line', function () {
        const failure = testCase('rejects a bad transfer', '/checkout/' + ALPHA, {
            err: { message: 'expected success\nbut received rejection' }
        })
        const value = report([], [], [failure])

        assertResult(run(value, [ALPHA]), 1, [
            JSON.stringify(value.stats),
            'RAIL VERDICT FAIL 1 failing: rejects a bad transfer: expected success'
        ])
    })

    it('prints a failing before-all hook', function () {
        const failure = testCase('"before all" hook', '/checkout/' + ALPHA, {
            err: { message: 'venue did not start' }
        })
        const value = report([], [], [failure])

        assertResult(run(value, [ALPHA]), 1, [
            JSON.stringify(value.stats),
            'RAIL VERDICT FAIL 1 failing: "before all" hook: venue did not start'
        ])
    })

    it('fails when one named drive file has no passing case', function () {
        const value = report([testCase('alpha passes', '/checkout/' + ALPHA)])

        assertResult(run(value, [ALPHA, BETA]), 1, [
            JSON.stringify(value.stats),
            'RAIL VERDICT FAIL no passing case in ' + BETA
        ])
    })
})

describe('rail verdict report input', function () {
    it('fails when the report is missing', function () {
        const reportPath = path.join(tempDir, 'report.json')
        const result = spawnSync(process.execPath, [SCRIPT, reportPath, ALPHA], {
            cwd: REPO_ROOT,
            encoding: 'utf8'
        })

        assertResult(result, 1, [
            'RAIL VERDICT FAIL no readable mocha JSON report at ' + reportPath
        ])
    })

    it('fails when the report cannot be parsed', function () {
        const result = run('{not JSON', [ALPHA], true)
        const reportPath = path.join(tempDir, 'report.json')

        assertResult(result, 1, [
            'RAIL VERDICT FAIL no readable mocha JSON report at ' + reportPath
        ])
    })

    it('ignores pending cases from unnamed files', function () {
        const value = report(
            [testCase('alpha passes', '/checkout/' + ALPHA)],
            [testCase('root hook is pending', '/checkout/test/initial_check.test.js')]
        )

        assertResult(run(value, [ALPHA]), 0, [
            JSON.stringify(value.stats),
            'RAIL VERDICT PASS 1 passing, 0 failing, 0 skipped across 1 drive file(s): ' + ALPHA
        ])
    })
})
