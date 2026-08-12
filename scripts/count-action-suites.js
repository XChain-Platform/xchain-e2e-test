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

// Reads the decoder's action vocabulary by parsing the source rather than by
// requiring it: the script has to stay side-effect free and dependency free so
// docs tooling can run it in a bare checkout.
function readDecoderVocabulary() {
    if (!fs.existsSync(DECODER_SRC)) return null

    const src = fs.readFileSync(DECODER_SRC, 'utf8')

    const namesBlock = src.match(/const VALID_ACTION_NAMES = new Set\(\[([\s\S]*?)\]\)/)
    if (!namesBlock) return null
    const names = [...namesBlock[1].matchAll(/'([A-Z][A-Z0-9]*)'/g)].map((m) => m[1])
    if (names.length === 0) return null

    const aliasBlock = src.match(/const ACTION_ALIASES = \{([\s\S]*?)\n\}/)
    const aliases = {}
    if (aliasBlock) {
        for (const m of aliasBlock[1].matchAll(/'([A-Z][A-Z0-9]*)'\s*:\s*'([A-Z][A-Z0-9]*)'/g)) {
            aliases[m[1]] = m[2]
        }
    }

    return { names, aliases }
}

function vocabulary() {
    const fromDecoder = readDecoderVocabulary()
    return {
        names: new Set(fromDecoder ? fromDecoder.names : FALLBACK_ACTION_NAMES),
        aliases: fromDecoder ? fromDecoder.aliases : {},
        source: fromDecoder ? 'xchain-decoder VALID_ACTION_NAMES' : 'vendored fallback list'
    }
}

// Collects a suite plus every test/ module it reaches through relative
// requires; helper modules are where most payload literals actually live.
function requireClosure(entry, seen = new Set()) {
    const resolved = fs.existsSync(entry) ? entry : entry + '.js'
    if (!fs.existsSync(resolved) || seen.has(resolved)) return seen
    seen.add(resolved)

    const src = fs.readFileSync(resolved, 'utf8')
    for (const m of src.matchAll(LOCAL_REQUIRE)) {
        const target = path.resolve(path.dirname(resolved), m[2])
        const candidate = fs.existsSync(target) && fs.statSync(target).isFile() ? target : target + '.js'
        if (candidate.startsWith(TEST_ROOT + path.sep)) requireClosure(candidate, seen)
    }
    return seen
}

function countActionSuites() {
    const vocab = vocabulary()
    const suites = fs.readdirSync(ACTIONS_DIR).filter((f) => f.endsWith('.test.js')).sort()

    const bySuite = {}
    const actions = new Set()

    for (const suite of suites) {
        const found = new Set()
        for (const file of requireClosure(path.join(ACTIONS_DIR, suite))) {
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
        suiteFiles: suites.length,
        actions: [...actions].sort(),
        count: actions.size,
        bySuite
    }
}

module.exports = { countActionSuites, FALLBACK_ACTION_NAMES }

if (require.main === module) {
    const result = countActionSuites()
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify(result, null, 2))
    } else {
        console.log('ACTION test suites (one per ACTION name, versions folded in): ' + result.count)
        console.log('Vocabulary source: ' + result.vocabularySource)
        console.log('Suite files scanned under test/actions/: ' + result.suiteFiles)
        console.log(result.actions.join(', '))
    }
}
