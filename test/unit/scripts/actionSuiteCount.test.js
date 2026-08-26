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

// The component docs published an "ACTION test suites" figure that was
// counted by hand once and then went stale: two actions (COLLECT and PRICE)
// gained suites and the number never moved, and nobody could re-derive it
// because "suite" had never been defined. The operator settled the definition
// on 2026-08-11 (one suite per ACTION NAME, versions folded in), and
// scripts/count-action-suites.js implements it. These guards keep the published
// numbers tied to the tree:
//
//  - VOCABULARY DRIFT: the script falls back to a vendored action list in a
//    standalone checkout. If the decoder adds an action and the fallback does
//    not follow, a bare clone would silently under-count.
//  - PUBLISHED-FIGURE DRIFT: the docs numbers must equal what the script and a
//    directory listing report right now, so adding a suite that the docs do not
//    reflect fails here rather than in a reader's face.
//  - ALIAS-FOLDING DRIFT: a suite may spell an action in short form, and the
//    script folds it onto the canonical name before counting. That folding died
//    silently once, when the decoder moved ACTION_ALIASES into its own module
//    and the script's inline-literal regex stopped matching, so the guards below
//    assert the alias table is present, equals the decoder's, and actually folds.
//
// The tier is hermetic on purpose: the counting rule was chosen precisely so
// the figure needs no regtest venue to reproduce.

const assert  = require('assert')
const fs      = require('fs')
const os      = require('os')
const path    = require('path')
const counter = require('../../../scripts/count-action-suites')

const REPO_ROOT   = path.join(__dirname, '../../..')
const DECODER_SRC = path.join(REPO_ROOT, '../xchain-decoder/src/XChainDecoder.js')
const ALIAS_SRC   = path.join(REPO_ROOT, '../xchain-decoder/src/actionAliases.js')
const DOCS_ROOT   = process.env.XCHAIN_DOCS_ROOT || path.join(REPO_ROOT, '../xchain-documentation')
const DOCS_E2E    = path.join(DOCS_ROOT, 'components/e2e-test')

function readDocs(file) {
    return fs.readFileSync(path.join(DOCS_E2E, file), 'utf8')
}

describe('published ACTION test-suite count', () => {

    const recount = counter.countActionSuites()

    describe('the counting rule is reproducible from the tree', () => {

        it('every counted name is a real protocol ACTION name', function () {
            if (!fs.existsSync(DECODER_SRC)) return this.skip()

            const decoderSrc = fs.readFileSync(DECODER_SRC, 'utf8')
            const block = decoderSrc.match(/const VALID_ACTION_NAMES = new Set\(\[([\s\S]*?)\]\)/)
            assert.ok(block, 'decoder no longer declares VALID_ACTION_NAMES as a Set literal; ' +
                'scripts/count-action-suites.js parses that declaration and needs updating')

            const valid = new Set([...block[1].matchAll(/'([A-Z][A-Z0-9]*)'/g)].map((m) => m[1]))
            const strays = recount.actions.filter((a) => !valid.has(a))
            assert.deepStrictEqual(strays, [],
                'counted names that the decoder does not recognise as actions: ' + strays.join(', '))
        })

        it('the standalone-checkout fallback vocabulary matches the decoder', function () {
            if (!fs.existsSync(DECODER_SRC)) return this.skip()

            const decoderSrc = fs.readFileSync(DECODER_SRC, 'utf8')
            const block = decoderSrc.match(/const VALID_ACTION_NAMES = new Set\(\[([\s\S]*?)\]\)/)
            const valid = [...block[1].matchAll(/'([A-Z][A-Z0-9]*)'/g)].map((m) => m[1]).sort()

            assert.deepStrictEqual([...counter.FALLBACK_ACTION_NAMES].sort(), valid,
                'FALLBACK_ACTION_NAMES in scripts/count-action-suites.js has drifted from the ' +
                'decoder VALID_ACTION_NAMES set; re-vendor it')
        })

        it('the parsed alias table equals the decoder alias module', function () {
            if (!fs.existsSync(ALIAS_SRC)) return this.skip()

            const decoderAliases = require(ALIAS_SRC)
            assert.deepStrictEqual(counter.vocabulary().aliases, { ...decoderAliases },
                'the alias table this script reads has drifted from ' +
                'xchain-decoder/src/actionAliases.js. It went empty once before, when the table ' +
                'moved out of XChainDecoder.js and the inline-literal regex stopped matching; ' +
                'an unfolded alias is dropped from the published count with no error')
        })

        it('the alias table is never empty when the decoder checkout is present', function () {
            if (!fs.existsSync(DECODER_SRC)) return this.skip()

            const vocab = counter.vocabulary()
            assert.ok(Object.keys(vocab.aliases).length > 0,
                'alias folding is dead: the script reported a vocabulary with no aliases while ' +
                'the sibling decoder checkout is present')
            assert.strictEqual(vocab.aliasSource, 'xchain-decoder actionAliases.js',
                'the alias table silently degraded to ' + vocab.aliasSource +
                ' while the decoder checkout is present')
        })

        it('the standalone-checkout fallback alias table matches the decoder', function () {
            if (!fs.existsSync(ALIAS_SRC)) return this.skip()

            assert.deepStrictEqual({ ...counter.FALLBACK_ACTION_ALIASES }, { ...require(ALIAS_SRC) },
                'FALLBACK_ACTION_ALIASES in scripts/count-action-suites.js has drifted from the ' +
                'decoder alias table; re-vendor it')
        })

        it('every alias expands to a real action name and is not one itself', function () {
            const vocab = counter.vocabulary()
            for (const [alias, canonical] of Object.entries(vocab.aliases)) {
                assert.ok(vocab.names.has(canonical),
                    'alias ' + alias + ' expands to ' + canonical + ', which is not an action name')
                assert.ok(!vocab.names.has(alias),
                    'alias ' + alias + ' is itself an action name, so folding it would rewrite a ' +
                    'real action into a different one')
            }
        })

        it('folds a short-form alias in a suite onto its canonical action', () => {
            // The path that regressed. Counted against a fixture tree rather than
            // the real one, because no suite here spells an action in short form,
            // which is exactly why the dead folding stayed invisible.
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'action-count-alias-'))
            try {
                const actionsDir = path.join(root, 'actions')
                fs.mkdirSync(actionsDir)
                fs.writeFileSync(path.join(actionsDir, 'alias.test.js'),
                    'const payload = "MSG|0|abc"\nconst plain = "ISSUE|0|abc"\n')

                const counted = counter.countActionSuites({ actionsDir, testRoot: root })
                assert.ok(counted.actions.includes('MESSAGE'),
                    'the MSG alias was not folded onto MESSAGE; it counted ' +
                    JSON.stringify(counted.actions))
                assert.ok(!counted.actions.includes('MSG'),
                    'the raw alias token leaked into the counted set')
                assert.ok(counted.actions.includes('ISSUE'),
                    'the fixture counter lost a canonical action name')
            } finally {
                fs.rmSync(root, { recursive: true, force: true })
            }
        })

        it('counts distinct ACTION names, not suite files', () => {
            // The whole point of the rule: 69-odd files collapse onto far fewer
            // action names, because versions and reorg/negative variants of one
            // action are the same entry.
            assert.ok(recount.count < recount.suiteFiles,
                'the recount produced one entry per file, which is not the ACTION-name rule')
            assert.ok(recount.count > 0, 'the recount found no actions at all')
        })
    })

    describe('the component docs publish the recounted figures', () => {

        it('README.md states the recounted ACTION-name count and list', function () {
            if (!fs.existsSync(DOCS_E2E)) return this.skip()

            const readme = readDocs('README.md')
            const bullet = readme.match(/\*\*(\d+) ACTION test suites\*\*[^:]*:([^\n]*)/)
            assert.ok(bullet, 'README.md no longer carries an "**N ACTION test suites**" bullet')

            assert.strictEqual(Number(bullet[1]), recount.count,
                'README.md publishes ' + bullet[1] + ' ACTION test suites; the tree has ' +
                recount.count + '. Re-run: node scripts/count-action-suites.js')

            const published = bullet[2].split(',').map((s) => s.trim()).filter(Boolean).sort()
            assert.deepStrictEqual(published, recount.actions,
                'the ACTION names listed in README.md differ from the recounted set')
        })

        it('README.md states the counting rule next to the figure', function () {
            if (!fs.existsSync(DOCS_E2E)) return this.skip()

            const readme = readDocs('README.md')
            assert.ok(/one suite per ACTION name/i.test(readme),
                'README.md must state the counting rule so the figure is reproducible')
            assert.ok(/count-action-suites\.js/.test(readme),
                'README.md must name the script that regenerates the figure')
        })

        it('architecture.md counts the action suite files and helper modules on disk', function () {
            if (!fs.existsSync(DOCS_E2E)) return this.skip()

            const arch = readDocs('architecture.md')

            const files = arch.match(/actions\/\s*#\s*(\d+) action test files/)
            assert.ok(files, 'architecture.md no longer annotates test/actions/ with a file count')
            assert.strictEqual(Number(files[1]), recount.suiteFiles,
                'architecture.md publishes ' + files[1] + ' action test files; the tree has ' +
                recount.suiteFiles)

            const helpers = arch.match(/helpers\/\s*#\s*(\d+) modules/)
            assert.ok(helpers, 'architecture.md no longer annotates test/helpers/ with a module count')
            assert.strictEqual(Number(helpers[1]), helperModuleCount(),
                'architecture.md publishes ' + helpers[1] + ' helper modules; the tree has ' +
                helperModuleCount())
        })

        it('README.md counts the helper modules on disk', function () {
            if (!fs.existsSync(DOCS_E2E)) return this.skip()

            const readme = readDocs('README.md')
            const helpers = readme.match(/action helpers \((\d+) modules\)/)
            assert.ok(helpers, 'README.md no longer annotates the helper layer with a module count')
            assert.strictEqual(Number(helpers[1]), helperModuleCount(),
                'README.md publishes ' + helpers[1] + ' helper modules; the tree has ' +
                helperModuleCount())
        })
    })
})

function helperModuleCount() {
    return fs.readdirSync(path.join(REPO_ROOT, 'test/helpers')).filter((f) => f.endsWith('.js')).length
}
