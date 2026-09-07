#!/usr/bin/env node
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
 **********************************************************************
 *
 * Swallowed-give-up gate.
 *
 * `Database.waitForX` returns null when it runs out of budget, and prints a
 * GAVE UP line saying why. Null is the RIGHT answer for a negative poll: a
 * test proving a row never lands needs the timeout back as data. It is the
 * wrong answer anywhere the row is then used, because the null is stored, the
 * run walks on, and the failure lands several assertions later on the wrong
 * rule. That is how a rejected parent ISSUE hid a DOGE caret root cause behind
 * a "wrong rejection status" failure, and it is worse in a fixture
 * builder under test/helpers/, whose caller never sees the GAVE UP line at all.
 *
 * So every `indexerDatabase.waitForX` / `db.waitForX` call site under test/
 * must do ONE of:
 *
 *   - wrap the wait in requireRow() from test/helpers/requireRow.js (the
 *     fixture-builder shape: fail at the wait, naming the row that never came)
 *   - guard it with an explicit `if (!row) throw`
 *   - assert on the row (`assert(row, ...)`, `expect(row)...`) before using it
 *   - hand it straight back (`return await db.waitForX(...)`) or test it inline
 *   - say why an empty result is fine, on the call's own line or the one above:
 *         // give-up-ok: <reason>
 *     which covers a deliberate negative poll, a sequencing wait whose real
 *     assertion comes later, and a diagnostic query whose result is only logged.
 *
 * The marker is deliberately a sentence, not a bare pragma: the whole point of
 * this gate is that a reader can tell a swallow from a decision.
 *
 * Usage:  node scripts/check-wait-swallow.js [--list]
 *
 ********************************************************************/

'use strict'

const fs   = require('fs')
const path = require('path')

const ROOT       = path.join(__dirname, '..')
const SCAN_DIR   = path.join(ROOT, 'test')
const HELPER_DIR = path.join(ROOT, 'test', 'helpers')

// test/unit/ never touches a live database; its waitFor mentions are the unit
// coverage OF the wait machinery, not uses of it.
const SKIP_DIRS = new Set(['node_modules', 'unit'])

// Only the Database row polls (src/db.js `waitForX` -> `_waitFor`), which are
// the family that returns null and prints GAVE UP. The suite's other waitForX
// helpers (waitForReady, waitForMesh, waitForMirror, waitForGossip, and the
// deliberately status-agnostic waitForAnyX in stakeHelper) answer a different
// question and carry their own contracts, so a receiver-blind match would bury
// the real class under them.
const WAIT_CALL = /(?:^|[^\w.])(?:[\w.]+\.)?(?:indexerDatabase|db)\.waitFor[A-Z]\w*\s*\(/
const OPT_OUT   = /\/\/\s*give-up-ok:\s*\S/

// Where the enclosing function ends and the next one begins: an object-literal
// or class method head (`async sendSendV0(addressInfo, tick){`), the closing
// line of a multi-line head (`){`), and a mocha block (`it('...', async () => {`).
// Bounds the search for a guard, so a guard belonging to the NEXT function is
// never credited to this wait. Control-flow keywords open a block INSIDE the
// same function, so they are not boundaries; requiring the trailing `{` keeps
// an ordinary call such as `assert(row, 'msg')` from reading as a head.
const METHOD_HEAD = /^\s{0,8}(?:(?:async\s+)?[\w$]+\s*\(.*|\)\s*)\{\s*$/
const NOT_A_HEAD  = /^\s*(?:if|for|while|do|switch|try|catch|else|return|await|assert|expect)\b/

function walk(dir, acc){
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })){
        if (entry.isDirectory()){
            if (SKIP_DIRS.has(entry.name)) continue
            walk(path.join(dir, entry.name), acc)
        } else if (entry.name.endsWith('.js')){
            acc.push(path.join(dir, entry.name))
        }
    }
    return acc
}

// The variable a wait's result is bound to, from the head of its own line.
// Handles `let row =`, `const row =`, and the reassignment `row =`.
function boundName(line){
    const m = /(?:^|[;{])\s*(?:let|const|var)\s+([\w$]+)\s*=/.exec(line)
        || /^\s*([\w$]+)\s*=\s*(?:await\s+)?[\w.]*\bwaitFor/.exec(line)
    return m ? m[1] : null
}

// Does the enclosing function fail loud when `name` comes back null? Looks for
// an `if (!name)` whose block throws, or an assertion naming it, anywhere from
// this wait to the end of the function. The whole function is in scope on
// purpose: a two-stage wait (a short probe, then a wider one, then the
// diagnosis) guards both waits with one throw at the end, and crediting only
// the adjacent lines would call that deliberate shape a swallow.
function guardedByThrow(lines, from, name){
    if (!name) return false
    const esc      = name.replace(/[$]/g, '\\$')
    const nullTest = new RegExp('if\\s*\\(\\s*!\\s*' + esc + '\\b')
    const asserted = new RegExp('(?:assert|expect)[\\w.]*\\([^;]*\\b' + esc + '\\b')
    for (let i = from + 1; i < lines.length; i++){
        if (asserted.test(lines[i])) return true
        if (i > from + 1 && METHOD_HEAD.test(lines[i]) && !NOT_A_HEAD.test(lines[i])) break
        if (!nullTest.test(lines[i])) continue
        // The guard's block: this line plus the few that close it.
        if (/\bthrow\b/.test(lines.slice(i, i + 12).join('\n'))) return true
    }
    return false
}

function scanLines(lines, rel, isHelper){
    const hits = []
    lines.forEach((line, idx) => {
        // A comment describing a wait is not a wait.
        const code = line.replace(/\/\/.*$/, '')
        if (!WAIT_CALL.test(code)) return
        // The marker counts on the call's own line or anywhere in the comment
        // block directly above it, because the reason usually needs a sentence
        // and a one-line-only rule would push it onto the code line.
        if (OPT_OUT.test(line)) return
        let opted = false
        for (let k = idx - 1; k >= 0 && /^\s*\/\//.test(lines[k]); k--){
            if (OPT_OUT.test(lines[k])) { opted = true; break }
        }
        if (opted) return
        // Wrapped at the call: requireRow(await db.waitForX({...}), '...').
        if (/requireRow\s*\(\s*(?:await\s+)?[\w.]*\bwaitFor[A-Z]/.test(code)) return
        // Handed straight back or tested inline, so no null is stored here and
        // the decision belongs to the caller: `return await db.waitForX(...)`,
        // `if (await db.waitForX(...))`.
        if (/\b(?:return|if\s*\()\s*(?:!\s*)?(?:await\s+)?[\w.]*\bwaitFor[A-Z]/.test(code)) return
        if (guardedByThrow(lines, idx, boundName(code))) return
        hits.push({ file: rel, line: idx + 1, helper: isHelper, text: line.trim() })
    })
    return hits
}

function scanFile(file){
    return scanLines(
        fs.readFileSync(file, 'utf8').split('\n'),
        path.relative(ROOT, file),
        file.startsWith(HELPER_DIR + path.sep),
    )
}

function scan(){
    const hits = []
    for (const f of walk(SCAN_DIR, []).sort()) hits.push(...scanFile(f))
    return {
        helpers: hits.filter((h) => h.helper),
        tests:   hits.filter((h) => !h.helper),
        all:     hits,
    }
}

function main(){
    const { helpers, tests, all } = scan()

    if (process.argv.includes('--list')){
        helpers.forEach((h) => console.log(`HELPER ${h.file}:${h.line}  ${h.text}`))
        tests.forEach((h) => console.log(`  test ${h.file}:${h.line}  ${h.text}`))
    }

    if (!all.length){
        console.log('wait-swallow: every waitFor site under test/ fails loud or says why it need not.')
        return 0
    }

    if (helpers.length){
        console.error(`wait-swallow: ${helpers.length} fixture-helper waits swallow their give-up:`)
        helpers.forEach((h) => console.error(`  ${h.file}:${h.line}  ${h.text}`))
        console.error('A helper hands its row to a caller that never sees the GAVE UP line, so a null')
        console.error('walks on and fails somewhere misleading.')
    }
    if (tests.length){
        console.error(`wait-swallow: ${tests.length} in-test waits swallow their give-up:`)
        tests.forEach((h) => console.error(`  ${h.file}:${h.line}  ${h.text}`))
    }
    console.error('Fix a site by wrapping the wait in requireRow() (test/helpers/requireRow.js),')
    console.error('guarding it with `if (!row) throw`, or asserting on the row before using it.')
    console.error('If an empty result is genuinely fine, say why on the call line or the one above:')
    console.error('    // give-up-ok: <reason>')
    return 1
}

module.exports = { scan, scanFile, scanLines, boundName, guardedByThrow }

if (require.main === module) process.exit(main())
