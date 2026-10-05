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
const fs = require('fs')
const os = require('os')
const path = require('path')
const proxyquire = require('proxyquire').noPreserveCache()

const SCRIPT_DIR = path.dirname(require.resolve('../../../scripts/stage-siblings'))
let sandbox
let root
let script
let logs
let errors
let mutations
let originalLog
let originalError

function sandboxJoin(...parts) {
    if (parts.length === 2 && parts[0] === SCRIPT_DIR && parts[1] === '..') return root
    return path.join(...parts)
}

function setUp() {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-siblings-'))
    root = path.join(sandbox, 'project')
    mutations = []
    const instrumentedFs = {
        ...fs,
        rmSync(...args) {
            mutations.push('rm')
            return fs.rmSync(...args)
        },
        symlinkSync(...args) {
            mutations.push('symlink')
            return fs.symlinkSync(...args)
        },
        unlinkSync(...args) {
            mutations.push('unlink')
            return fs.unlinkSync(...args)
        }
    }
    fs.mkdirSync(root)
    script = proxyquire('../../../scripts/stage-siblings', {
        fs: instrumentedFs,
        path: { join: sandboxJoin }
    })
    logs = []
    errors = []
    originalLog = console.log
    originalError = console.error
    console.log = (message) => logs.push(message)
    console.error = (message) => errors.push(message)
}

function tearDown() {
    console.log = originalLog
    console.error = originalError
    fs.rmSync(sandbox, { recursive: true, force: true })
}

function addSibling(name) {
    const sibling = path.join(sandbox, name)
    fs.mkdirSync(sibling)
    fs.writeFileSync(path.join(sibling, 'package.json'), '{}\n')
    return sibling
}

describe('stage-siblings helpers', () => {
    beforeEach(setUp)
    afterEach(tearDown)

    it('recognizes only directories containing package.json as snapshots', () => {
        const snapshot = path.join(sandbox, 'snapshot')
        const debris = path.join(sandbox, 'debris')
        fs.mkdirSync(snapshot)
        fs.mkdirSync(debris)
        fs.writeFileSync(path.join(snapshot, 'package.json'), '{}\n')

        assert.strictEqual(script.hasSnapshot(snapshot), true)
        assert.strictEqual(script.hasSnapshot(debris), false)
    })

    it('stages, reports, unstages, and reports the missing vendor path', () => {
        addSibling('fixture-package')

        assert.strictEqual(script.stageOne('fixture-package'), true)
        assert.strictEqual(fs.lstatSync(path.join(root, 'fixture-package')).isSymbolicLink(), true)
        script.checkOne('fixture-package')
        assert(logs.includes('fixture-package: symlink -> ../fixture-package'))

        logs.length = 0
        assert.strictEqual(script.unstageOne('fixture-package'), true)
        script.checkOne('fixture-package')
        assert(logs.includes('fixture-package: absent'))
    })

    it('reports a missing sibling without creating a vendor path', () => {
        assert.strictEqual(script.stageOne('missing-package'), false)
        assert.strictEqual(fs.existsSync(path.join(root, 'missing-package')), false)
        assert.match(errors.join('\n'), /missing-package: sibling checkout not found/)
    })

    it('treats repeated staging as a no-op', () => {
        addSibling('fixture-package')
        assert.strictEqual(script.stageOne('fixture-package'), true)
        const firstTarget = fs.readlinkSync(path.join(root, 'fixture-package'))
        assert.deepStrictEqual(mutations, ['symlink'])
        mutations.length = 0

        assert.strictEqual(script.stageOne('fixture-package'), true)
        assert.strictEqual(fs.readlinkSync(path.join(root, 'fixture-package')), firstTarget)
        assert.deepStrictEqual(mutations, [])
        assert.match(logs.join('\n'), /already a symlink/)
    })
})
