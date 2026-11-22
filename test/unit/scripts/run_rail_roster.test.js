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
const { readRailRoster } = require('../../../bin/rail-roster')

const REPO_ROOT = path.resolve(__dirname, '../../..')
const SCRIPT = path.join(REPO_ROOT, 'bin', 'run-rail-roster.js')

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

function runWithFakeNpx(output, stdoutNoise = '') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-roster-npx-'))
    const executable = path.join(directory, 'npx')
    const argsFile = path.join(directory, 'args.txt')
    fs.writeFileSync(executable, [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > "$FAKE_ARGS"',
        'for arg in "$@"; do case "$arg" in output=*) out="${arg#output=}";; esac; done',
        'printf "%s" "$FAKE_NOISE"',
        '[ -n "$FAKE_REPORT" ] && printf "%s" "$FAKE_REPORT" > "$out"',
        'exit 0',
        ''
    ].join('\n'))
    fs.chmodSync(executable, 0o755)
    try {
        const result = spawnSync(process.execPath, [SCRIPT], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: directory + path.delimiter + process.env.PATH,
                FAKE_ARGS: argsFile,
                FAKE_REPORT: output,
                FAKE_NOISE: stdoutNoise
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
        const roster = readRailRoster().suites
        const suites = roster.filter(entry => entry.run)
        const skipped = roster.filter(entry => !entry.run)
        const lines = result.stdout.trim().split('\n')
        const command = lines.at(-1)
        const expected = [
            'npx', 'mocha', '--timeout', '0', '--exit', '--require',
            './test/initial_check.test.js', '--reporter', 'json',
            '--reporter-option', 'output=<report-file>',
            ...suites.map(entry => entry.file)
        ]
        assert.deepStrictEqual(lines.slice(0, -1), skipped.map(entry => 'skip ' + entry.file + ': ' + entry.why))
        assert.deepStrictEqual(command.split(' '), expected)
        assert.ok(skipped.every(entry => !command.includes(entry.file)))
        assert.ok(fs.existsSync(path.resolve(REPO_ROOT, expected[6])))
        const smokePositions = suites
            .filter(entry => entry.file.startsWith('test/smoke/'))
            .map(entry => command.indexOf(entry.file))
        const actionPositions = suites
            .filter(entry => entry.file.startsWith('test/actions/'))
            .map(entry => command.indexOf(entry.file))
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

    it('runs the exact serial mocha argv and judges the reporter output file', () => {
        const suites = readRailRoster().suites.filter(entry => entry.run).map(entry => entry.file)
        const { result, args } = runWithFakeNpx(JSON.stringify(reportFor(suites)))

        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stdout, /rail roster: GREEN/)
        const reporterOption = args.indexOf('--reporter-option')
        assert.match(args[reporterOption + 1], /^output=.+report\.json$/)
        assert.deepStrictEqual(args.filter((arg, index) => index < reporterOption || index > reporterOption + 1), [
            'mocha', '--timeout', '0', '--exit', '--require',
            './test/initial_check.test.js', '--reporter', 'json', ...suites
        ])
        assert.ok(!args.includes('--parallel'))
    })

    it('ignores test log lines on stdout when the report file is valid', () => {
        const suites = readRailRoster().suites.filter(entry => entry.run).map(entry => entry.file)
        const { result } = runWithFakeNpx(JSON.stringify(reportFor(suites)), 'log line {not json\n[tx] mined 0xabc\n')

        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stdout, /rail roster: GREEN/)
    })

    it('classifies a non-json report file as a venue failure', () => {
        const { result } = runWithFakeNpx('not json')

        assert.strictEqual(result.status, 95, result.stderr)
        assert.match(result.stderr, /VENUE.*parseable mocha json/)
    })

    it('classifies a missing report file as a venue failure', () => {
        const { result } = runWithFakeNpx('', 'only log lines on stdout\n')

        assert.strictEqual(result.status, 95, result.stderr)
        assert.match(result.stderr, /VENUE.*parseable mocha json/)
    })
})
