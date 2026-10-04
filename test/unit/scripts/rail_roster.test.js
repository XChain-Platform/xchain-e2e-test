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
const path = require('path')
const { readRailRoster, auditRailRoster } = require('../../../scripts/rail-roster')

const REPO_ROOT = path.resolve(__dirname, '../../..')
const SMOKE_FILES = [
    'test/smoke/001-bootstrap.smoke.js',
    'test/smoke/002-connectivity.smoke.js',
    'test/smoke/003-database.smoke.js',
    'test/smoke/004-crypto.smoke.js',
    'test/smoke/005-mining.smoke.js',
    'test/smoke/006-gas-token.smoke.js',
    'test/smoke/007-minimal-e2e.smoke.js'
]

function suite(file, run = true, why) {
    return { file, run, why }
}

function auditWith(entry) {
    return auditRailRoster({
        suites: [suite(SMOKE_FILES[0]), entry]
    }, REPO_ROOT)
}

function assertNamed(problems, file, message) {
    assert.ok(problems.some(problem => problem.includes(file) && message.test(problem)),
        'expected a problem naming ' + file + ':\n' + problems.join('\n'))
}

describe('rail roster', () => {
    it('ships a clean roster with every smoke suite and at least eight action suites', () => {
        const roster = readRailRoster()
        assert.deepStrictEqual(auditRailRoster(roster, REPO_ROOT), [])
        const files = roster.suites.map(entry => entry.file)
        assert.deepStrictEqual(files.slice(0, SMOKE_FILES.length), SMOKE_FILES)
        assert.ok(roster.suites.filter(entry => entry.file.startsWith('test/actions/')).length >= 8)
    })

    it('names a file that does not exist', () => {
        const file = 'test/actions/missing.test.js'
        assertNamed(auditWith(suite(file)), file, /does not exist/)
    })

    it('names a file outside the smoke and action directories', () => {
        const file = 'package.json'
        assertNamed(auditWith(suite(file)), file, /must be under/)
    })

    it('names a duplicate entry', () => {
        const file = SMOKE_FILES[0]
        const problems = auditRailRoster({ suites: [suite(file), suite(file)] }, REPO_ROOT)
        assertNamed(problems, file, /duplicate/)
    })

    it('names an entry whose run flag is not boolean', () => {
        const file = 'test/actions/send.test.js'
        assertNamed(auditWith(suite(file, 'yes')), file, /must be a boolean/)
    })

    it('names a disabled entry with no non-empty reason', () => {
        const file = 'test/actions/send.test.js'
        assertNamed(auditWith(suite(file, false, '   ')), file, /non-empty why/)
    })

    it('names the smoke entry when none is enabled', () => {
        const file = SMOKE_FILES[0]
        const problems = auditRailRoster({ suites: [suite(file, false, 'disabled')] }, REPO_ROOT)
        assertNamed(problems, file, /no run:true smoke/)
    })
})
