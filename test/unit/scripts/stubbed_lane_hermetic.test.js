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

// The stubbed integration lane (package.json `test:integration:stubbed`, and the
// phase-2 mutation spec built on it) must stay hermetic: a live suite in it skips
// itself on a host without Docker and the lane still reports a number. A live
// suite split into a same-named `<root>.test/` directory lands one directory deep,
// exactly where the stubbed glob looks, so these guards resolve the real selection
// with mocha's own file collector and check it by location and by content. They
// also pin the other half of that exclusion: every split part of a live root is
// reached from its root, or excluding its directory drops it from every lane.

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')
const { pathToFileURL } = require('url')
const collectFiles = require('mocha/lib/cli/collect-files')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const INTEGRATION_DIR = path.join(REPO_ROOT, 'test', 'integration')
const LIVE_MARKERS = /require\([^)]*\b(disposableHubDb|multiValidatorHubHelper)\b/

// Resolve a mocha spec/ignore selection to sorted repo-relative paths.
function resolveSelection(spec, ignore) {
    const out = collectFiles({ spec, ignore, extension: ['js'], file: [], recursive: false, sort: false })
    const files = Array.isArray(out) ? out : out.files
    return files.map(f => path.relative(REPO_ROOT, f).split(path.sep).join('/')).sort()
}

// Read the spec and --ignore globs out of the npm stubbed script.
function stubbedScriptSelection() {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    const script = pkg.scripts['test:integration:stubbed']
    const ignore = [...script.matchAll(/--ignore\s+'([^']+)'/g)].map(m => m[1])
    const spec = [...script.matchAll(/'([^']+)'/g)].map(m => m[1]).filter(g => !ignore.includes(g))
    return resolveSelection(spec, ignore)
}

// Local relative requires of one file, resolved to absolute .js paths.
function localRequires(file) {
    const src = fs.readFileSync(file, 'utf8')
    return [...src.matchAll(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g)]
        .map(m => path.resolve(path.dirname(file), m[2]))
        .map(p => (p.endsWith('.js') ? p : p + '.js'))
        .filter(p => fs.existsSync(p))
}

// Every file reachable from `entry` through local relative requires.
function reachableFrom(entry) {
    const seen = new Set([entry])
    const queue = [entry]
    while (queue.length) {
        for (const next of localRequires(queue.shift())) {
            if (!seen.has(next)) { seen.add(next); queue.push(next) }
        }
    }
    return seen
}

describe('stubbed integration lane stays hermetic', () => {

    it('selects no split-part directory and no file that requires a live helper', () => {
        const files = stubbedScriptSelection()
        assert.ok(files.length > 0, 'the stubbed lane resolved to no files, so it proves nothing')
        const splitParts = files.filter(f => /^test\/integration\/[^/]+\.test\//.test(f))
        assert.deepStrictEqual(splitParts, [],
            'the stubbed lane selects split parts of live suites:\n  ' + splitParts.join('\n  '))
        const live = files.filter(f => LIVE_MARKERS.test(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')))
        assert.deepStrictEqual(live, [],
            'the stubbed lane selects files that provision a live database or hub mesh:\n  ' + live.join('\n  '))
    })

    it('phase-2 mutation spec resolves to the same integration files as the npm script', async () => {
        const config = (await import(pathToFileURL(path.join(REPO_ROOT, 'stryker.phase2.config.mjs')).href)).default
        const { spec, ignore = [] } = config.mochaOptions
        const integration = resolveSelection(spec, ignore).filter(f => f.startsWith('test/integration/'))
        assert.deepStrictEqual(integration, stubbedScriptSelection(),
            'stryker.phase2.config.mjs and package.json test:integration:stubbed select different integration files')
    })

    it('every split part of a live root is reached from that root', () => {
        const orphans = []
        for (const dir of fs.readdirSync(INTEGRATION_DIR).filter(d => d.endsWith('.integration.test'))) {
            const root = path.join(INTEGRATION_DIR, dir + '.js')
            const reached = fs.existsSync(root) ? reachableFrom(root) : new Set()
            for (const part of fs.readdirSync(path.join(INTEGRATION_DIR, dir)).filter(f => f.endsWith('.test.js'))) {
                if (!reached.has(path.join(INTEGRATION_DIR, dir, part))) orphans.push(dir + '/' + part)
            }
        }
        assert.deepStrictEqual(orphans, [],
            'split parts that no root requires run in no lane once the stubbed lane ignores them:\n  '
            + orphans.join('\n  '))
    })
})
