#!/usr/bin/env node
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Recounts the "ACTION test suites" figure the component docs publish.
//
// The counting rule (operator decision, 2026-08-11) is one suite per ACTION
// NAME, with every version of an action folded into that action's single
// entry: ISSUE V0-V5 is one, SEND V0-V3 is one. The figure is therefore a
// count of distinct protocol ACTION names, not of files and not of Mocha
// `describe` blocks, which is what makes it reproducible without a live
// regtest stack.
//
// An ACTION name counts when a suite under test/actions/ actually builds a
// payload for it. Payloads are always assembled as "NAME|<version>|..."
// string literals, either in the suite itself or in a test/ helper the suite
// pulls in, so we walk each suite's local require graph and read the leading
// token out of those literals. Tokens are then filtered against the decoder's
// VALID_ACTION_NAMES (aliases folded to their canonical spelling), so a stray
// capitalized literal can never inflate the number.

const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.join(__dirname, '..')
const ACTIONS_DIR = path.join(REPO_ROOT, 'test/actions')
const TEST_ROOT = path.join(REPO_ROOT, 'test')
const DECODER_SRC = path.join(REPO_ROOT, '../xchain-decoder/src/XChainDecoder.js')
// The alias table moved out of XChainDecoder.js into its own leaf module to
// break a require cycle with batchSubCommandCapture.js. Read it where it lives
// now; the inline-literal parse below is kept only for an older sibling.
const ALIAS_SRC = path.join(REPO_ROOT, '../xchain-decoder/src/actionAliases.js')

// Leading token of an ACTION payload literal: "ISSUE|0|...", `SEND|${v}|...`,
// "BATCH|" + version + ... . The delimiter class after the pipe keeps ordinary
// prose and SQL out of the result set.
const PAYLOAD_LITERAL = /["'`]([A-Z][A-Z0-9]{2,})\|(?:\d+|["'`]|\$\{)/g

const LOCAL_REQUIRE = /require\((['"])(\.[^'"]+)\1\)/g

// Fallback vocabulary, used only when the sibling decoder checkout is absent
// (a standalone xchain-e2e-test clone). test/unit/actionSuiteCount.test.js
// asserts this list is identical to the decoder's VALID_ACTION_NAMES whenever
// the sibling IS present, so the two cannot drift silently.
const FALLBACK_ACTION_NAMES = [
    'ADDRESS', 'AIRDROP', 'ANCHOR', 'ATTEST',
    'BATCH', 'BET', 'BROADCAST', 'CALLBACK', 'COINPAY', 'COLLECT',
    'DELEGATE', 'DEPLOY', 'DEPOSIT', 'DESTROY', 'DISPENSER',
    'DIVIDEND', 'EXECUTE', 'FILE', 'ISSUE', 'LINK', 'LIST', 'MESSAGE', 'MINT',
    'NODEPROOF', 'ORDER', 'PRICE', 'SEND', 'SLASH', 'SLEEP', 'STAKE', 'SWAP',
    'SWEEP', 'UNSTAKE', 'VOTE', 'WITHDRAW'
]

// Fallback alias table, same contract as FALLBACK_ACTION_NAMES: used only when
// the sibling decoder checkout is absent. Without it a standalone clone folds
// nothing and drops any suite that spells an action in short form, which is the
// silent under-count this whole script exists to prevent.
const FALLBACK_ACTION_ALIASES = {
    TRANSFER: 'SEND',
    ADDR: 'ADDRESS',
    DROP: 'AIRDROP',
    CAST: 'BROADCAST',
    MSG: 'MESSAGE'
}

// Loads the decoder's short-form alias table. Requiring is safe here where
// requiring the decoder itself is not: actionAliases.js is a leaf (one object
// literal and a module.exports, no requires, no side effects), while
// XChainDecoder.js would pull in its whole dependency tree.
//
// Fails LOUDLY when the sibling is present but the table cannot be read. The
// regression this replaces did the opposite: the inline-literal regex stopped
// matching after the table moved, aliases silently became {}, and the count
// gate kept reporting a number with its alias folding dead.
function readDecoderAliases(decoderSrc) {
    if (fs.existsSync(ALIAS_SRC)) {
        const table = require(ALIAS_SRC)
        if (table && typeof table === 'object' && Object.keys(table).length > 0) {
            return { aliases: { ...table }, aliasSource: 'xchain-decoder actionAliases.js' }
        }
    }

    // Older sibling checkout, before the table moved out of XChainDecoder.js.
    const aliasBlock = decoderSrc.match(/const ACTION_ALIASES = \{([\s\S]*?)\n\}/)
    if (aliasBlock) {
        const aliases = {}
        for (const m of aliasBlock[1].matchAll(/'([A-Z][A-Z0-9]*)'\s*:\s*'([A-Z][A-Z0-9]*)'/g)) {
            aliases[m[1]] = m[2]
        }
        if (Object.keys(aliases).length > 0) {
            return { aliases, aliasSource: 'xchain-decoder XChainDecoder.js inline literal' }
        }
    }

    throw new Error(
        'count-action-suites: the sibling decoder checkout is present but its ACTION_ALIASES table ' +
        'could not be read from ' + ALIAS_SRC + ' or as an inline literal in ' + DECODER_SRC + '. ' +
        'The table moved or changed shape; update this script rather than counting with no aliases, ' +
        'because an unfolded alias is dropped from the published figure with no error.'
    )
}

// Reads the decoder's action vocabulary. VALID_ACTION_NAMES is parsed out of
// the source rather than required, because requiring XChainDecoder.js would
// pull in its whole dependency tree and this script must stay side-effect free
// and dependency free so docs tooling can run it in a bare checkout. The alias
// table is loaded from its own leaf module instead (see readDecoderAliases):
// parsing it was what silently broke when the table moved.
function readDecoderVocabulary() {
    if (!fs.existsSync(DECODER_SRC)) return null

    const src = fs.readFileSync(DECODER_SRC, 'utf8')

    const namesBlock = src.match(/const VALID_ACTION_NAMES = new Set\(\[([\s\S]*?)\]\)/)
    if (!namesBlock) return null
    const names = [...namesBlock[1].matchAll(/'([A-Z][A-Z0-9]*)'/g)].map((m) => m[1])
    if (names.length === 0) return null

    const { aliases, aliasSource } = readDecoderAliases(src)

    return { names, aliases, aliasSource }
}

function vocabulary() {
    const fromDecoder = readDecoderVocabulary()
    return {
        names: new Set(fromDecoder ? fromDecoder.names : FALLBACK_ACTION_NAMES),
        aliases: fromDecoder ? fromDecoder.aliases : { ...FALLBACK_ACTION_ALIASES },
        source: fromDecoder ? 'xchain-decoder VALID_ACTION_NAMES' : 'vendored fallback list',
        aliasSource: fromDecoder ? fromDecoder.aliasSource : 'vendored fallback list'
    }
}

// Collects a suite plus every test/ module it reaches through relative
// requires; helper modules are where most payload literals actually live.
function requireClosure(entry, testRoot = TEST_ROOT, seen = new Set()) {
    const resolved = fs.existsSync(entry) ? entry : entry + '.js'
    if (!fs.existsSync(resolved) || seen.has(resolved)) return seen
    seen.add(resolved)

    const src = fs.readFileSync(resolved, 'utf8')
    for (const m of src.matchAll(LOCAL_REQUIRE)) {
        const target = path.resolve(path.dirname(resolved), m[2])
        const candidate = fs.existsSync(target) && fs.statSync(target).isFile() ? target : target + '.js'
        if (candidate.startsWith(testRoot + path.sep)) requireClosure(candidate, testRoot, seen)
    }
    return seen
}

// actionsDir/testRoot default to this repo's own tree; they are parameters only
// so a test can drive the counter over a fixture suite and prove alias folding
// actually happens, which nothing could express before.
function countActionSuites({ actionsDir = ACTIONS_DIR, testRoot = TEST_ROOT } = {}) {
    const vocab = vocabulary()
    const suites = fs.readdirSync(actionsDir).filter((f) => f.endsWith('.test.js')).sort()

    const bySuite = {}
    const actions = new Set()

    for (const suite of suites) {
        const found = new Set()
        for (const file of requireClosure(path.join(actionsDir, suite), testRoot)) {
            const src = fs.readFileSync(file, 'utf8')
            for (const m of src.matchAll(PAYLOAD_LITERAL)) {
                const name = vocab.aliases[m[1]] || m[1]
                if (vocab.names.has(name)) found.add(name)
            }
        }
        bySuite[suite] = [...found].sort()
        found.forEach((a) => actions.add(a))
    }

    return {
        vocabularySource: vocab.source,
        aliasSource: vocab.aliasSource,
        suiteFiles: suites.length,
        actions: [...actions].sort(),
        count: actions.size,
        bySuite
    }
}

module.exports = { countActionSuites, vocabulary, FALLBACK_ACTION_NAMES, FALLBACK_ACTION_ALIASES }

if (require.main === module) {
    const result = countActionSuites()
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify(result, null, 2))
    } else {
        console.log('ACTION test suites (one per ACTION name, versions folded in): ' + result.count)
        console.log('Vocabulary source: ' + result.vocabularySource)
        console.log('Alias source: ' + result.aliasSource)
        console.log('Suite files scanned under test/actions/: ' + result.suiteFiles)
        console.log(result.actions.join(', '))
    }
}
