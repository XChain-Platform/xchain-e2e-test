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
const { readRailRoster, auditRailRoster } = require('./rail-roster')

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
    const files = suites.filter(entry => entry.run).map(entry => entry.file)
    console.log(['npx', ...MOCHA_ARGS, ...files].join(' '))
}

function main(argv) {
    const roster = readRailRoster()
    const problems = auditRailRoster(roster, REPO_ROOT)
    if (problems.length) {
        printAuditProblems(problems)
        return 1
    }
    if (argv.length === 1 && argv[0] === '--list') {
        listRoster(roster.suites)
        return 0
    }
    if (argv.length === 1 && argv[0] === '--dry-run') {
        printDryRun(roster.suites)
        return 0
    }
    console.error('Usage: node scripts/run-rail-roster.js --list|--dry-run')
    return 2
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = { main }
