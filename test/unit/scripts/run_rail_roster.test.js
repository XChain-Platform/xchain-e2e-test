'use strict'

// GENERATED TEST CONTRACT

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
const { readRailRoster } = require('../../../scripts/rail-roster')

const REPO_ROOT = path.resolve(__dirname, '../../..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'run-rail-roster.js')

function runCli(...args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
    })
}

function reportFor(suites, failingFile) {
    const test = file => ({ file: path.join(REPO_ROOT, file) })
    return {
        passes: suites.filter(file => file !== failingFile).map(test),
        failures: failingFile ? [test(failingFile)] : [],
        pending: []
    }
}

function runReport(report) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-roster-report-'))
    const file = path.join(directory, 'report.json')
    fs.writeFileSync(file, JSON.stringify(report))
    try {
        return runCli('--report-file', file)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
}

function runWithFakeNpx(output) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-roster-npx-'))
    const executable = path.join(directory, 'npx')
    const argsFile = path.join(directory, 'args.txt')
    fs.writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_ARGS"\nprintf "%s" "$FAKE_REPORT"\n')
    fs.chmodSync(executable, 0o755)
    try {
        const result = spawnSync(process.execPath, [SCRIPT], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: directory + path.delimiter + process.env.PATH,
                FAKE_ARGS: argsFile,
                FAKE_REPORT: output
            }
        })
        const args = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n') : []
        return { result, args }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
}

describe('rail roster runner', () => {
    it('--list exits zero and names every roster file', () => {
        const result = runCli('--list')
        assert.strictEqual(result.status, 0, result.stderr)
        const expected = readRailRoster().suites.map(entry => entry.run
            ? 'run ' + entry.file
            : 'skip ' + entry.file + ': ' + entry.why)
        assert.deepStrictEqual(result.stdout.trim().split('\n'), expected)
    })

    it('--dry-run prints serial mocha argv with smoke files before action files', () => {
        const result = runCli('--dry-run')
        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stdout, /--reporter json/)
        assert.ok(!result.stdout.includes('--parallel'))
        const suites = readRailRoster().suites.filter(entry => entry.run)
        const expected = [
            'npx', 'mocha', '--timeout', '0', '--exit', '--require',
            './test/initial_check.test.js', '--reporter', 'json',
            ...suites.map(entry => entry.file)
        ]
        assert.deepStrictEqual(result.stdout.trim().split(' '), expected)
        assert.ok(fs.existsSync(path.resolve(REPO_ROOT, expected[6])))
        const smokePositions = suites
            .filter(entry => entry.file.startsWith('test/smoke/'))
            .map(entry => result.stdout.indexOf(entry.file))
        const actionPositions = suites
            .filter(entry => entry.file.startsWith('test/actions/'))
            .map(entry => result.stdout.indexOf(entry.file))
        assert.ok(smokePositions.every(position => position >= 0))
        assert.ok(actionPositions.every(position => position >= 0))
        assert.ok(Math.max(...smokePositions) < Math.min(...actionPositions))
    })
})

describe('rail roster verdicts', () => {
    it('--report-file exits zero and prints GREEN when every run file passes', () => {
        const suites = readRailRoster().suites.filter(entry => entry.run).map(entry => entry.file)
        const result = runReport(reportFor(suites))

        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stdout, /rail roster: GREEN/)
    })

    it('--report-file exits one and prints RED when one run file fails', () => {
        const suites = readRailRoster().suites.filter(entry => entry.run).map(entry => entry.file)
        const result = runReport(reportFor(suites, suites[0]))

        assert.strictEqual(result.status, 1, result.stderr)
        assert.match(result.stdout, /rail roster: RED/)
    })

    it('runs the exact serial mocha argv and judges captured stdout', () => {
        const suites = readRailRoster().suites.filter(entry => entry.run).map(entry => entry.file)
        const { result, args } = runWithFakeNpx(JSON.stringify(reportFor(suites)))

        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stdout, /rail roster: GREEN/)
        assert.deepStrictEqual(args, [
            'mocha', '--timeout', '0', '--exit', '--require',
            './test/initial_check.test.js', '--reporter', 'json', ...suites
        ])
        assert.ok(!args.includes('--parallel'))
    })

    it('classifies non-json mocha stdout as a venue failure', () => {
        const { result } = runWithFakeNpx('not json')

        assert.strictEqual(result.status, 95, result.stderr)
        assert.match(result.stderr, /VENUE.*parseable mocha json/)
    })
})
