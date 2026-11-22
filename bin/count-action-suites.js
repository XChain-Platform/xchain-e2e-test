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
// An ACTION name counts when a suite at any depth under test/actions/ actually
// builds a payload for it. Payloads may be assembled as "NAME|<version>|..."
// string literals or as [NAME, version, ...].join('|') arrays, either in the
// suite itself or in a test/ helper the suite pulls in. We walk each suite's
// local require graph and read those leading tokens. Tokens are then filtered
// against the decoder's VALID_ACTION_NAMES (aliases folded to their canonical
// spelling), so a stray capitalized literal can never inflate the number.

const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.join(__dirname, '..')
const ACTIONS_DIR = path.join(REPO_ROOT, 'test/actions')
const TEST_ROOT = path.join(REPO_ROOT, 'test')
const DECODER_SRC = path.join(REPO_ROOT, '../xchain-decoder/src/XChainDecoder.js')
// The alias table moved out of XChainDecoder.js into its own leaf module to
// break a require cycle with batchSubCommandCapture.js. Read it where it lives
// now; the inline-literal parse below is kept only for an older sibling.
const ALIAS_SRC = path.join(REPO_ROOT, '../xchain-decoder/src/protocol/action_aliases.js')
// The decoder's constructor/method split moved the VALID_ACTION_NAMES Set
// literal out of the entry and into this part file beside it.
const CONSTANTS_SRC = path.join(REPO_ROOT, '../xchain-decoder/src/XChainDecoder/constants.js')

// Leading token of an ACTION payload literal: "ISSUE|0|...", `SEND|${v}|...`,
// "BATCH|" + version + ... . The delimiter class after the pipe keeps ordinary
// prose and SQL out of the result set.
const PAYLOAD_LITERAL = /["'`]([A-Z][A-Z0-9]{2,})\|(?:\d+|["'`]|\$\{)/g
const PAYLOAD_ARRAY_HEAD = /\[\s*["'`]([A-Z][A-Z0-9]{2,})["'`]\s*,\s*["'`]?\d+["'`]?\s*[,\]]/g
const PIPE_JOIN = /^\s*\.join\(\s*(["'`])\|\1\s*\)/

const LOCAL_REQUIRE = /require\((['"])(\.[^'"]+)\1\)/g

// Fallback vocabulary, used only when the sibling decoder checkout is absent
// (a standalone xchain-e2e-test clone). test/unit/scripts/action_suite_count.test.js
// asserts this list is identical to the decoder's VALID_ACTION_NAMES whenever
// the sibling IS present, so the two cannot drift silently.
const FALLBACK_ACTION_NAMES = [
    'ADDRESS', 'AIRDROP', 'ANCHOR', 'ATTEST',
    'BATCH', 'BET', 'BROADCAST', 'CALLBACK', 'COINPAY', 'COLLECT',
    'DELEGATE', 'DEPLOY', 'DEPOSIT', 'DESTROY', 'DISPENSER',
    'DIVIDEND', 'EXECUTE', 'FILE', 'ISSUE', 'LINK', 'LIST', 'MESSAGE', 'MINT',
    'NODEPROOF', 'ORDER', 'PRICE', 'ROLLCALL', 'SEND', 'SLASH', 'SLEEP', 'STAKE',
    'SWAP',
    'SWEEP', 'UNSTAKE', 'VOTE', 'WITHDRAW', 'XBRIDGE'
]

// Fallback alias table, same contract and same guard test as FALLBACK_ACTION_NAMES:
// used only when the sibling decoder checkout is absent. Without it a standalone
// clone folds nothing and drops any suite that spells an action in short form,
// which is the silent under-count this whole script exists to prevent.
const FALLBACK_ACTION_ALIASES = {
    TRANSFER: 'SEND',
    ADDR: 'ADDRESS',
    DROP: 'AIRDROP',
    CAST: 'BROADCAST',
    MSG: 'MESSAGE'
}

// Loads the decoder's short-form alias table. Requiring is safe here where
// requiring the decoder itself is not: action_aliases.js is a leaf (one object
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
            return { aliases: { ...table }, aliasSource: 'xchain-decoder action_aliases.js' }
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

// Finds the VALID_ACTION_NAMES Set literal wherever it currently lives: the
// constants part the decoder's constructor/method split moved it into
// (src/XChainDecoder/constants.js), checked first, then the entry
// (src/XChainDecoder.js) for a checkout still at the pre-split layout. Reads
// text rather than requiring either file, for the same side-effect-free
// reason as readDecoderAliases below.
//
// Returns null only when the decoder checkout itself is absent, matching the
// standalone-clone fallback path. When the checkout IS present but neither
// file declares the literal, that is real drift (the declaration moved again
// or changed shape) and must fail loudly naming both paths, never degrade to
// the vendored fallback vocabulary with no error.
function findActionNamesBlock() {
    if (!fs.existsSync(DECODER_SRC)) return null

    for (const candidate of [CONSTANTS_SRC, DECODER_SRC]) {
        if (!fs.existsSync(candidate)) continue
        const src = fs.readFileSync(candidate, 'utf8')
        const block = src.match(/const VALID_ACTION_NAMES = new Set\(\[([\s\S]*?)\]\)/)
        if (block) return { block, source: candidate }
    }

    throw new Error(
        'count-action-suites: the sibling decoder checkout is present but VALID_ACTION_NAMES ' +
        'could not be found as a Set literal in ' + CONSTANTS_SRC + ' or ' + DECODER_SRC + '. ' +
        'The declaration moved or changed shape; update this script rather than counting with ' +
        'the vendored fallback vocabulary, because a stale name list is a silent under- or over-count.'
    )
}

// Reads the decoder's action vocabulary. VALID_ACTION_NAMES is parsed out of
// the source rather than required, because requiring XChainDecoder.js would
// pull in its whole dependency tree and this script must stay side-effect free
// and dependency free so docs tooling can run it in a bare checkout. The alias
// table is loaded from its own leaf module instead (see readDecoderAliases):
// parsing it was what silently broke when the table moved.
function readDecoderVocabulary() {
    const found = findActionNamesBlock()
    if (!found) return null

    const names = [...found.block[1].matchAll(/'([A-Z][A-Z0-9]*)'/g)].map((m) => m[1])
    if (names.length === 0) return null

    const { aliases, aliasSource } = readDecoderAliases(fs.readFileSync(DECODER_SRC, 'utf8'))

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

function actionSuiteFiles(dir, base = dir, found = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || (entry.isDirectory() && entry.name.startsWith('.'))) continue
        const absolute = path.join(dir, entry.name)
        if (entry.isDirectory()) actionSuiteFiles(absolute, base, found)
        else if (entry.isFile() && entry.name.endsWith('.test.js'))
            found.push(path.relative(base, absolute).split(path.sep).join('/'))
    }
    return found.sort()
}

// A slash after one of these (or after one of these keywords) opens a regex
// literal; after an identifier, number or closing bracket it is division.
const REGEX_PRECEDER = /(?:[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of|delete|void|throw|new|yield|await))\s*$/

// Quote and backslash characters inside a regex literal must not open a
// string, so the body runs to the closing slash outside any character class.
function regexEnd(source, start) {
    let inClass = false
    for (let i = start + 1; i < source.length && source[i] !== '\n'; i++) {
        if (source[i] === '\\') i++
        else if (source[i] === '[') inClass = true
        else if (source[i] === ']') inClass = false
        else if (source[i] === '/' && !inClass) return i + 1
    }
    return -1
}

// Plain quotes cannot span a line, so a stray quote is bounded to its line.
function quotedEnd(source, start) {
    const quote = source[start]
    let i = start + 1
    while (i < source.length && source[i] !== quote) {
        if (quote !== '`' && source[i] === '\n') return i
        i += source[i] === '\\' ? 2 : 1
    }
    return Math.min(i + 1, source.length)
}

// The non-code span opening at i as [blankFrom, end], or null. A literal keeps
// its opening delimiter, so a later slash never reads a blanked string as an
// operator that would open a regex.
function nonCodeSpan(source, out, i) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') return [i + 1, quotedEnd(source, i)]
    if (source.startsWith('//', i)) {
        const newline = source.indexOf('\n', i)
        return [i, newline === -1 ? source.length : newline]
    }
    if (source.startsWith('/*', i)) {
        const close = source.indexOf('*/', i + 2)
        return [i, close === -1 ? source.length : close + 2]
    }
    if (ch === '/' && REGEX_PRECEDER.test(out.slice(Math.max(0, i - 16), i).join(''))) {
        const end = regexEnd(source, i)
        if (end !== -1) return [i + 1, end]
    }
    return null
}

// Blank out comment text and string and regex bodies (keeping length and
// newlines) so a bracket inside any of them never reads as code.
function maskNonCode(source) {
    const out = source.split('')
    let i = 0
    while (i < source.length) {
        const span = nonCodeSpan(source, out, i)
        if (!span) {
            i++
            continue
        }
        for (let j = span[0]; j < span[1]; j++) if (source[j] !== '\n') out[j] = ' '
        i = span[1]
    }
    return out.join('')
}

function arrayEnd(masked, start) {
    let depth = 0
    for (let i = start; i < masked.length; i++) {
        if (masked[i] === '[') depth++
        else if (masked[i] === ']' && --depth === 0) return i + 1
    }
    return -1
}

// Names whose [NAME, version, ...] array is live code and is joined with '|'.
// The head is read from the original text but only at a bracket the masked
// text shows as code, so commented-out or quoted examples never count.
function arrayPayloadNames(source) {
    const masked = maskNonCode(source)
    const names = []
    for (const match of source.matchAll(PAYLOAD_ARRAY_HEAD)) {
        if (masked[match.index] !== '[') continue
        const end = arrayEnd(masked, match.index)
        if (end !== -1 && PIPE_JOIN.test(source.slice(end))) names.push(match[1])
    }
    return names
}

// actionsDir/testRoot default to this repo's own tree; they are parameters only
// so a test can drive the counter over a fixture suite and prove alias folding
// actually happens, which nothing could express before.
function countActionSuites({ actionsDir = ACTIONS_DIR, testRoot = TEST_ROOT } = {}) {
    const vocab = vocabulary()
    const suites = actionSuiteFiles(actionsDir)

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
            for (const rawName of arrayPayloadNames(src)) {
                const name = vocab.aliases[rawName] || rawName
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

module.exports = { countActionSuites, vocabulary, FALLBACK_ACTION_NAMES, FALLBACK_ACTION_ALIASES, findActionNamesBlock }

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
