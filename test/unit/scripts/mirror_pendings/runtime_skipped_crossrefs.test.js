'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const checkerPath = path.resolve(__dirname, '../../../../bin/check-mirror-pendings.js')
const pendingTitle = 'holds delivery (needs a future harness lever; DRIVEN in at2b: "holds the barrier")'
const reason = '// The harness cannot drive this barrier state without an external lever.'

function runCrossref (legSource) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-pendings-runtime-'))
    fs.writeFileSync(path.join(root, 'at2.test.js'),
        "describe('AT2', () => { it.skip(" + JSON.stringify(pendingTitle) + ', () => {}) })')
    fs.writeFileSync(path.join(root, 'at2b-forward-margin.test.js'), legSource)
    return spawnSync(process.execPath, [checkerPath, root], { encoding: 'utf8' })
}

function assertRefused (result) {
    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /no active case titled "holds the barrier"/)
    assert.doesNotMatch(result.stderr, /unreasoned pending/)
}

describe('check-mirror-pendings runtime-skipped cross-reference targets', function () {
    it('refuses a target skipped by its own body', function () {
        assertRefused(runCrossref([
            "describe('m', () => {",
            "  it('holds the barrier', function () {",
            '    ' + reason,
            '    this.skip()',
            '  })',
            '})',
        ].join('\n')))
    })

    it('refuses a semicolonless direct skip after a declaration', function () {
        assertRefused(runCrossref([
            "describe('m', () => {",
            "  it('holds the barrier', function () {",
            '    const setupComplete = true',
            '    ' + reason,
            '    this.skip()',
            '  })',
            '})',
        ].join('\n')))
    })

    it('refuses an unconditional skip inside a plain block', function () {
        assertRefused(runCrossref([
            "describe('m', () => {",
            "  it('holds the barrier', function () {",
            '    {',
            '      ' + reason,
            '      this.skip()',
            '    }',
            '  })',
            '})',
        ].join('\n')))
    })

    it('keeps a conditional skip after a declaration eligible', function () {
        const result = runCrossref([
            "describe('target', () => {",
            "  it('holds the barrier', function () {",
            '    const setupComplete = true',
            '    if (!setupComplete) {',
            '      ' + reason,
            '      this.skip()',
            '    }',
            '  })',
            '})',
        ].join('\n'))
        assert.strictEqual(result.status, 0, result.stderr)
    })

    for (const hook of ['before', 'beforeEach']) {
        it('refuses a target skipped by an enclosing ' + hook + ' hook', function () {
            assertRefused(runCrossref([
                "describe('m', () => {",
                '  ' + hook + '(function () {',
                '    ' + reason,
                '    this.skip()',
                '  })',
                "  it('holds the barrier', () => {})",
                '})',
            ].join('\n')))
        })
    }

    it('applies an outer hook skip to a nested target', function () {
        assertRefused(runCrossref([
            "describe('outer', () => {",
            '  before(function () {',
            '    ' + reason,
            '    this.skip()',
            '  })',
            "  describe('inner', () => { it('holds the barrier', () => {}) })",
            '})',
        ].join('\n')))
    })

    it('does not apply a hook skip to a sibling suite', function () {
        const result = runCrossref([
            "describe('other', () => { before(function () {",
            '  ' + reason,
            '  this.skip()',
            '}) })',
            "describe('target', () => { it('holds the barrier', () => {}) })",
        ].join('\n'))
        assert.strictEqual(result.status, 0, result.stderr)
    })

    for (const condition of ['flag', 'false']) {
        it('keeps a target with an if (' + condition + ') body skip eligible', function () {
            const result = runCrossref([
                "describe('target', () => {",
                "  it('holds the barrier', function () {",
                '    if (' + condition + ') {',
                '      ' + reason,
                '      this.skip()',
                '    }',
                '  })',
                '})',
            ].join('\n'))
            assert.strictEqual(result.status, 0, result.stderr)
        })

        it('keeps a target with a brace-less if (' + condition + ') skip eligible', function () {
            const result = runCrossref([
                "describe('target', () => {",
                "  it('holds the barrier', function () {",
                '    ' + reason,
                '    if (' + condition + ') this.skip()',
                '  })',
                '})',
            ].join('\n'))
            assert.strictEqual(result.status, 0, result.stderr)
        })
    }

    it('keeps a target with a conditional hook skip eligible', function () {
        const result = runCrossref([
            "describe('target', () => {",
            '  before(function () {',
            '    if (flag) {',
            '      ' + reason,
            '      this.skip()',
            '    }',
            '  })',
            "  it('holds the barrier', () => {})",
            '})',
        ].join('\n'))
        assert.strictEqual(result.status, 0, result.stderr)
    })

    it('keeps a standard availability guard eligible', function () {
        const result = runCrossref([
            "describe('target', () => {",
            '  before(function () {',
            '    if (!up) {',
            "      console.log('SKIPPED: ' + venue.unavailable)",
            '      this.skip()',
            '    }',
            '  })',
            "  it('holds the barrier', () => {})",
            '})',
        ].join('\n'))
        assert.strictEqual(result.status, 0, result.stderr)
    })
})
