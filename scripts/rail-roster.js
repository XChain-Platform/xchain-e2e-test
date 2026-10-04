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

const fs   = require('fs')
const path = require('path')

const DEFAULT_ROSTER = path.resolve(__dirname, '../test/rail/rail-roster.json')

function readRailRoster(file = DEFAULT_ROSTER) {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function rosterFile(entry) {
    return entry && typeof entry.file === 'string' ? entry.file : '<unknown file>'
}

function isAllowedFile(file) {
    const normalized = path.posix.normalize(file)
    return normalized === file
        && (file.startsWith('test/smoke/') || file.startsWith('test/actions/'))
}

function auditEntry(entry, repoRoot, seen) {
    const file = rosterFile(entry)
    const problems = []
    if (!fs.existsSync(path.resolve(repoRoot, file)))
        problems.push(file + ': file does not exist')
    if (!isAllowedFile(file))
        problems.push(file + ': file must be under test/smoke/ or test/actions/')
    if (seen.has(file))
        problems.push(file + ': duplicate roster entry')
    seen.add(file)
    if (!entry || typeof entry.run !== 'boolean')
        problems.push(file + ': run must be a boolean')
    if (entry && entry.run === false
        && (typeof entry.why !== 'string' || entry.why.trim() === ''))
        problems.push(file + ': run:false requires a non-empty why')
    return problems
}

function auditRailRoster(roster, repoRoot) {
    const suites = roster && Array.isArray(roster.suites) ? roster.suites : []
    const problems = []
    const seen = new Set()
    for (const entry of suites)
        problems.push(...auditEntry(entry, repoRoot, seen))
    if (!suites.some(entry => entry && entry.run === true
        && rosterFile(entry).startsWith('test/smoke/'))) {
        const file = suites.length ? rosterFile(suites[0]) : '<empty roster>'
        problems.push(file + ': roster has no run:true smoke entry')
    }
    return problems
}

module.exports = { readRailRoster, auditRailRoster }
