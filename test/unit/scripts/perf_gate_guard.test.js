'use strict'

// GENERATED TEST CONTRACT

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const cli = path.resolve(__dirname, '../../../scripts/perf-gate.js')

function runFixture(data) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-gate-'))
    const file = path.join(dir, 'perf-results.json')
    fs.writeFileSync(file, JSON.stringify(data))
    const result = spawnSync(process.execPath, [cli, '--file', file], { encoding: 'utf8' })
    fs.rmSync(dir, { recursive: true, force: true })
    return result
}

describe('perf-gate guards', () => {
    it('can be imported without running the CLI', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-gate-import-'))
        const missingFile = path.join(dir, 'missing-results.json')
        const importScript = [
            `process.argv = [process.execPath, 'perf-gate-import', '--file', ${JSON.stringify(missingFile)}]`,
            `const gate = require(${JSON.stringify(cli)})`,
            'if (typeof gate.run !== "function") process.exitCode = 3'
        ].join('\n')
        const result = spawnSync(process.execPath, ['-e', importScript], { encoding: 'utf8' })
        fs.rmSync(dir, { recursive: true, force: true })

        assert.strictEqual(result.status, 0, result.stdout + result.stderr)
        assert.strictEqual(result.stdout, '')
        assert.strictEqual(result.stderr, '')
    })

    it('fails a result file from a run that recorded no tests', () => {
        const result = runFixture({
            mochaStats: { tests: 0, passes: 0, duration: 0 },
            tests: [],
            pollMetrics: []
        })

        assert.strictEqual(result.status, 2, result.stdout + result.stderr)
        assert.match(result.stderr, /Empty performance results: no tests were recorded/)
        assert.doesNotMatch(result.stdout, /PASSED/)
    })

    it('allows a non-empty result within every threshold', () => {
        const result = runFixture({
            mochaStats: { tests: 1, passes: 1, duration: 100 },
            tests: [{ fullTitle: 'fast test', durationMs: 100, memEndRss: 1048576 }],
            pollMetrics: []
        })

        assert.strictEqual(result.status, 0, result.stdout + result.stderr)
        assert.match(result.stdout, /PASSED: all thresholds within limits/)
    })
})
