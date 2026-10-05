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

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')
const { readRailRoster, auditRailRoster } = require('./rail-roster')
const { judgeRailRun, formatVerdict } = require('./rail-run-verdict')

const REPO_ROOT = path.resolve(__dirname, '..')
const MOCHA_ARGS = [
    'mocha',
    '--timeout', '0',
    '--exit',
    '--require', './test/initialCheck.test.js',
    '--reporter', 'json'
]

function printAuditProblems(problems) {
    for (const problem of problems)
        console.error(problem)
}

function listRoster(suites) {
    for (const entry of suites) {
        const line = entry.run
            ? 'run ' + entry.file
            : 'skip ' + entry.file + ': ' + entry.why
        console.log(line)
    }
}

function printDryRun(suites) {
    console.log(['npx', ...mochaArgs(suites)].join(' '))
}

function mochaArgs(suites) {
    return [...MOCHA_ARGS, ...suites.filter(entry => entry.run).map(entry => entry.file)]
}

function printSkipped(suites) {
    for (const entry of suites.filter(entry => !entry.run))
        console.log('skip ' + entry.file + ': ' + entry.why)
}

function printVerdict(suites, report) {
    const expected = suites.filter(entry => entry.run).map(entry => entry.file)
    const verdict = judgeRailRun(expected, report, REPO_ROOT)
    console.log(formatVerdict(verdict))
    return verdict.ok ? 0 : 1
}

function judgeReportFile(suites, file) {
    const report = parseReport(fs.readFileSync(file, 'utf8'))
    return printVerdict(suites, report)
}

function parseReport(output) {
    const report = JSON.parse(output)
    if (!report || typeof report !== 'object')
        throw new SyntaxError('report is not a json object')
    return report
}

function runRoster(suites) {
    const result = spawnSync('npx', mochaArgs(suites), {
        cwd: REPO_ROOT,
        encoding: 'utf8'
    })
    let report
    try {
        report = parseReport(result.stdout)
    } catch (error) {
        console.error('rail roster: VENUE could not produce parseable mocha json: ' + error.message)
        return 95
    }
    return printVerdict(suites, report)
}

function dispatch(argv, suites) {
    if (argv.length === 1 && argv[0] === '--list') {
        listRoster(suites)
        return 0
    }
    printSkipped(suites)
    if (argv.length === 1 && argv[0] === '--dry-run') {
        printDryRun(suites)
        return 0
    }
    if (argv.length === 2 && argv[0] === '--report-file')
        return judgeReportFile(suites, argv[1])
    if (argv.length === 0) return runRoster(suites)
    console.error('Usage: node scripts/run-rail-roster.js [--list|--dry-run|--report-file <path>]')
    return 2
}

function main(argv) {
    const roster = readRailRoster()
    const problems = auditRailRoster(roster, REPO_ROOT)
    if (problems.length) {
        printAuditProblems(problems)
        return 1
    }
    return dispatch(argv, roster.suites)
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = { main }
