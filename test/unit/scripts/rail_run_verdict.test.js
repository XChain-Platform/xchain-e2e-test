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
const path = require('path')
const { judgeRailRun, formatVerdict } = require('../../../scripts/rail-run-verdict')

const REPO_ROOT = path.join(path.sep, 'fake', 'rail-repo')
const ALPHA = 'test/rail/alpha.rail.test.js'
const BETA = 'test/rail/beta.rail.test.js'
const EXTRA = 'test/rail/extra.rail.test.js'

function test(file) {
    return { file: path.join(REPO_ROOT, file) }
}

function report({ passes = [], failures = [], pending = [] }) {
    return {
        passes: passes.map(test),
        failures: failures.map(test),
        pending: pending.map(test)
    }
}

describe('rail run verdict', function () {
    it('is green when every expected file passes', function () {
        const verdict = judgeRailRun([ALPHA, BETA], report({ passes: [ALPHA, BETA] }), REPO_ROOT)

        assert.strictEqual(verdict.ok, true)
        assert.deepStrictEqual(verdict.problems, [])
        assert.strictEqual(verdict.tally.get(ALPHA).passing, 1)
        assert.strictEqual(formatVerdict(verdict), 'rail roster: GREEN')
    })

    it('reports a failing expected file', function () {
        const verdict = judgeRailRun([ALPHA], report({ failures: [ALPHA] }), REPO_ROOT)

        assert.strictEqual(verdict.ok, false)
        assert.deepStrictEqual(verdict.problems.map(({ file, kind }) => ({ file, kind })), [
            { file: ALPHA, kind: 'failing' }
        ])
    })

    it('reports an expected file absent from the report as ran-nothing', function () {
        const verdict = judgeRailRun([ALPHA], report({}), REPO_ROOT)

        assert.strictEqual(verdict.ok, false)
        assert.strictEqual(verdict.problems[0].file, ALPHA)
        assert.strictEqual(verdict.problems[0].kind, 'ran-nothing')
    })

    it('reports a passing expected file with a pending case', function () {
        const verdict = judgeRailRun(
            [ALPHA],
            report({ passes: [ALPHA], pending: [ALPHA] }),
            REPO_ROOT
        )

        assert.strictEqual(verdict.ok, false)
        assert.strictEqual(verdict.problems[0].kind, 'pending')
    })

    it('ignores a passing file outside the expected roster', function () {
        const verdict = judgeRailRun([ALPHA], report({ passes: [ALPHA, EXTRA] }), REPO_ROOT)

        assert.strictEqual(verdict.ok, true)
        assert.strictEqual(verdict.problems.length, 0)
    })

    it('formats every problem and counts them in the red line', function () {
        const verdict = judgeRailRun(
            [ALPHA, BETA],
            report({ failures: [ALPHA], passes: [BETA], pending: [BETA] }),
            REPO_ROOT
        )
        const formatted = formatVerdict(verdict)

        assert.match(formatted, new RegExp('^' + ALPHA + ': failing', 'm'))
        assert.match(formatted, new RegExp('^' + BETA + ': pending', 'm'))
        assert.match(formatted, /rail roster: RED \(2 problem\(s\)\)$/)
    })
})
