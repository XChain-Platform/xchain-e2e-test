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
const { spawnSync } = require('child_process')
const { readRailRoster } = require('../../../scripts/rail-roster')

const REPO_ROOT = path.resolve(__dirname, '../../..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'run-rail-roster.js')

function runCli(flag) {
    return spawnSync(process.execPath, [SCRIPT, flag], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
    })
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
            './test/initialCheck.test.js', '--reporter', 'json',
            ...suites.map(entry => entry.file)
        ]
        assert.deepStrictEqual(result.stdout.trim().split(' '), expected)
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
