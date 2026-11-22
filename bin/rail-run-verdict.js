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

const { tallyByFile, classify } = require('./run-live-tier')

function judgeRailRun(expectedFiles, report, repoRoot) {
    const tally = tallyByFile(report, repoRoot)
    const problems = classify(expectedFiles, tally)
    return { ok: problems.length === 0, problems, tally }
}

function formatVerdict(verdict) {
    const lines = verdict.problems.map(problem =>
        problem.file + ': ' + problem.kind + ' - ' + problem.detail)
    if (verdict.ok) lines.push('rail roster: GREEN')
    else lines.push('rail roster: RED (' + verdict.problems.length + ' problem(s))')
    return lines.join('\n')
}

module.exports = { judgeRailRun, formatVerdict }
