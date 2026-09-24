'use strict'

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
const cp     = require('child_process')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

const checker = require('../../../scripts/check-request-row-wait')
const script  = path.join(__dirname, '..', '..', '..', 'scripts', 'check-request-row-wait.js')

function scan (lines) {
    return checker.scanSource(lines.join('\n'), 'fixture.test.js')
}

function run (args) {
    return cp.spawnSync(process.execPath, [script].concat(args), { encoding: 'utf8' })
}

describe('check-request-row-wait classifications', function () {
    it('recognises a height wait on the emitted request block as guarded', function () {
        const hits = scan([
            'async function check(request) {',
            '    const requestId = request.requestId',
            '    const requestBlock = Number(request.blockIndex)',
            '    await waitForHeightWithClear(venue, 0, requestBlock)',
            '    return readRequestRow(venue, 0, requestId)',
            '}',
        ])
        assert.strictEqual(hits.length, 1)
        assert.strictEqual(hits[0].status, 'guarded')
        assert.strictEqual(hits[0].identifier, 'requestId')
    })

    it('names an unguarded read and its exact line', function () {
        const hits = scan([
            'async function check(requestId) {',
            '    await waitForMirrorRowEverywhere(venue, requestId)',
            '    return readRequestRow(venue, 0, requestId)',
            '}',
        ])
        assert.strictEqual(hits[0].status, 'unguarded')
        assert.strictEqual(hits[0].file, 'fixture.test.js')
        assert.strictEqual(hits[0].line, 3)
    })

    it('does not credit a wait on a different request height', function () {
        const hits = scan([
            'async function check(request, otherRequest) {',
            '    await waitForHeightWithClear(venue, 0, otherRequest.blockIndex)',
            '    return readRequestRow(venue, 0, request.requestId)',
            '}',
        ])
        assert.strictEqual(hits[0].status, 'unguarded')
    })

    it('credits a dominating wait outside a loop and explains the loop path', function () {
        const hits = scan([
            'async function check(request) {',
            '    await waitForHeightWithClear(venue, 0, request.blockIndex)',
            '    for (const sample of samples) {',
            '        sample.row = await readRequestRow(venue, 0, request.requestId)',
            '    }',
            '}',
        ])
        assert.strictEqual(hits[0].status, 'guarded')
        assert.match(hits[0].reason, /dominates the enclosing loop/)
    })

    it('does not let a conditional wait guard a read after the branch', function () {
        const hits = scan([
            'async function check(request, shouldWait) {',
            '    if (shouldWait) {',
            '        await waitForHeightWithClear(venue, 0, request.blockIndex)',
            '    }',
            '    return readRequestRow(venue, 0, request.requestId)',
            '}',
        ])
        assert.strictEqual(hits[0].status, 'unguarded')
    })

    it('reports an annotated deliberate exception instead of calling it clean', function () {
        const hits = scan([
            'async function check(requestId) {',
            '    // request-row-wait-ok: absence is the assertion in this poll.',
            '    return readRequestRow(venue, 0, requestId)',
            '}',
        ])
        assert.strictEqual(hits[0].status, 'exception')
        assert.match(hits[0].reason, /absence is the assertion/)
    })
})

describe('check-request-row-wait calibration fixtures', function () {
    it('recognises the ZC1 injected-reader shape as guarded', function () {
        const hits = scan([
            'async function waitForLocalRequestAtBlock(venue, indexerIndex, request, deps) {',
            '    const d = deps || {}',
            '    const waitForHeight = d.waitForHeight || waitForHeightWithClear',
            '    const readRow = d.readRow || readRequestRow',
            '    const requestId = String(request && request.requestId)',
            '    const rawBlockIndex = request && request.blockIndex',
            '    const blockIndex = Number(rawBlockIndex)',
            '    await waitForHeight(venue, indexerIndex, blockIndex)',
            '    return readRow(venue, indexerIndex, requestId)',
            '}',
        ])
        assert.strictEqual(hits.length, 1)
        assert.strictEqual(hits[0].status, 'guarded')
    })

    it('recognises the AT3 mirror-row-only shape as unguarded', function () {
        const hits = scan([
            'async function driveToMirrorRow(requestId) {',
            '    await waitForMirrorRowEverywhere(venue, requestId)',
            '    const local = await readRequestRow(venue, 0, requestId)',
            '    return local',
            '}',
        ])
        assert.strictEqual(hits.length, 1)
        assert.strictEqual(hits[0].status, 'unguarded')
    })
})

describe('check-request-row-wait input refusal', function () {
    it('exits one and names an unguarded request-row read', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-row-wait-bad-'))
        const file = path.join(dir, 'bad.js')
        try {
            fs.writeFileSync(file, 'async function check(requestId) {\n' +
                '    return readRequestRow(venue, 0, requestId)\n}\n')
            const result = run([file])
            assert.strictEqual(result.status, 1)
            assert.match(result.stdout, /UNGUARDED .*bad\.js:2 identifier=requestId/)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('counts an explained exception without treating it as unguarded', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-row-wait-exception-'))
        const file = path.join(dir, 'exception.js')
        try {
            fs.writeFileSync(file, 'async function check(requestId) {\n' +
                '    // request-row-wait-ok: absence is deliberately observed here.\n' +
                '    return readRequestRow(venue, 0, requestId)\n}\n')
            const result = run([file])
            assert.strictEqual(result.status, 0)
            assert.match(result.stdout, /acknowledged-exceptions 1/)
            assert.match(result.stdout, /EXCEPTION .*exception\.js:3 identifier=requestId/)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('exits nonzero and says zero files were read for an empty directory', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-row-wait-empty-'))
        try {
            const result = run([dir])
            assert.strictEqual(result.status, 2)
            assert.match(result.stderr, /read zero files/)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('distinguishes a missing path from an empty directory', function () {
        const missing = path.join(os.tmpdir(), 'request-row-wait-missing-' + process.pid)
        const result = run([missing])
        assert.strictEqual(result.status, 2)
        assert.match(result.stderr, /input path does not exist/)
        assert.doesNotMatch(result.stderr, /read zero files/)
    })

    it('refuses a file that was read but contains no request-row calls', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-row-wait-none-'))
        const file = path.join(dir, 'none.js')
        try {
            fs.writeFileSync(file, 'module.exports = true\n')
            const result = run([file])
            assert.strictEqual(result.status, 2)
            assert.match(result.stderr, /read 1 file\(s\) but found zero request-row reads/)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})
