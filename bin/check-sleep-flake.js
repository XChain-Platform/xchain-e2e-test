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
 * Fixed-settle sleep ratchet.
 *
 * This suite drives a live regtest stack, so tests wait for the indexer to
 * catch up. A wait is written two ways here, `await sleep(n)` (the helper form,
 * which includes a local timer helper of any name, such as `await pause(n)`, and
 * sleep/delay called through a receiver, such as `await rc.sleep(n)`)
 * and `await new Promise(r => setTimeout(r, n))` (the inline form), and both
 * spellings are read the same way. Two shapes of wait exist and only one of
 * them is flaky:
 *
 *   POLL INTERVAL - the wait as the last step of a loop that re-checks a
 *   condition and returns early. Deterministic: the loop exits as soon as the
 *   condition holds, and the wait only bounds how often it asks. Not counted.
 *
 *   FIXED SETTLE - a standalone wait used to "give the system time" before an
 *   assertion. Flaky by construction: it passes or fails on how busy the venue
 *   is. Counted.
 *
 * A raw grep for `await sleep(` conflates the two and lands around 178 hits,
 * which is why counting it that way produced a number nobody could act on. This
 * gate counts only the fixed-settle shape, freezes it at a committed baseline,
 * and fails when the count rises. It does NOT remediate the existing ones; it
 * stops the pile growing while they are paid down onto the wait helpers that
 * already exist (`_waitFor` in src/db/wait.js and its `waitForX` wrappers in src/db/*.js,
 * test/helpers/stakeHelper.js).
 *
 * Usage:  node bin/check-sleep-flake.js [--list] [--write-baseline]
 *
 ********************************************************************/

'use strict'

const fs   = require('fs')
const path = require('path')
const { scanNamed } = require('./lib/template_literal')
const { blankNonCode, loopMask } = require('./lib/sleep_flake_source')
const { readBaseline } = require('./lib/sleep_flake_baseline')

const ROOT         = path.join(__dirname, '..')
const SCAN_DIR     = path.join(ROOT, 'test')
const BASELINE_REL = path.join('bin', 'sleep-flake-baseline.json')
const BASELINE     = path.join(ROOT, BASELINE_REL)

// Only test/ is scanned. One-off drill scripts tracked outside it have no npm
// script running them, so ratcheting them would tax throwaway work for no CI gain.

// The two spellings of an awaited wait. Reading only the helper form left the
// inline one ungated: the shared indexer helpers (orderHelper, swapHelper,
// dispenserHelper) and the oracleBatch settles are all written that way, so a
// new wait of that shape could land without the count moving at all.
const HELPER_NAMES  = ['sleep', 'delay']
const AWAIT_PROMISE = /\bawait\s+new\s+Promise\s*\(/g

// Read a local timer helper of any other name (`pause`, `nap`) by its definition.
// Only a body that is ONE timer promise qualifies: a poll function with an inline
// timer inside its loop is not a wait, so awaiting it must not count.
const FN_HELPER  = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{\s*return\s+new\s+Promise\s*\(/g
const VAR_HELPER = new RegExp('\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s+)?'
    + '(?:function\\s*[\\w$]*\\s*\\([^()]*\\)\\s*\\{\\s*return|(?:\\([^()]*\\)|[A-Za-z_$][\\w$]*)\\s*=>'
    + '(?:\\s*\\{\\s*return)?)\\s*new\\s+Promise\\s*\\(', 'g')

// An awaited promise is a wait on a DURATION only when a timer resolves it.
// Two neighbouring shapes deliberately fall outside this: an event wait
// (`await new Promise(r => ws.on('open', r))`) resolves on a condition, and a
// `Promise.race` timeout arm carries no `await` of its own, so neither the
// helper definitions (`const sleep = (ms) => new Promise(...)`) nor the race
// arms reach the detector at all.
const TIMER_INSIDE  = /\bsetTimeout\s*\(/

function walk(dir, acc) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, acc)
        else if (entry.name.endsWith('.js')) acc.push(full)
    }
    return acc
}

// Span of the argument list of the call whose `(` sits at `open`. Counted over
// the blanked code, so a paren inside a string or comment cannot unbalance it.
function argSpan(code, open) {
    let depth = 0
    for (let i = open; i < code.length; i++) {
        if (code[i] === '(') depth++
        else if (code[i] === ')') { depth--; if (depth === 0) return { from: open + 1, to: i } }
    }
    return null
}

// Names this file binds to a single-timer-promise body, beside sleep/delay.
function timerHelperNames(code) {
    const names = new Set(HELPER_NAMES)
    for (const re of [FN_HELPER, VAR_HELPER]) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(code)) !== null) {
            const span = argSpan(code, m.index + m[0].length - 1)
            if (!span || !TIMER_INSIDE.test(code.slice(span.from, span.to))) continue
            const block = /\breturn\s+new\s+Promise\s*\($/.test(m[0])
            const tail  = code.slice(span.to + 1)
            if (block ? /^\s*;?\s*\}/.test(tail) : /^\s*(?:[;,)\n]|$)/.test(tail)) names.add(m[1])
        }
    }
    return [...names]
}

// The awaited-helper regex for this file, built from its own helper names.
// Read sleep/delay behind any receiver (`await rc.sleep(n)`); keep a local name bare-only,
// because it was found by its definition here and `stream.pause()` is another function.
function awaitHelperRe(code) {
    const esc    = (n) => n.replace(/\$/g, '\\$')
    const bare   = timerHelperNames(code).map(esc).join('|')
    const member = HELPER_NAMES.map(esc).join('|')
    const recv   = '(?:[A-Za-z_$][\\w$]*\\s*\\??\\.\\s*)+'
    return new RegExp(`\\bawait\\s+(?:${recv}(?:${member})|(?:${bare}))\\s*\\(`, 'g')
}

function scanSource(src, name) {
    const code = scanNamed(name, () => blankNonCode(src))
    const { mask, balanced } = loopMask(code)
    const hits = []
    const lineStarts = [0]
    for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1)
    const lineOf = (off) => {
        let lo = 0, hi = lineStarts.length - 1
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1 }
        return lo + 1
    }
    const lines = src.split('\n')

    const offsets = []
    let m
    const awaitHelper = awaitHelperRe(code)
    while ((m = awaitHelper.exec(code)) !== null) offsets.push(m.index)
    AWAIT_PROMISE.lastIndex = 0
    while ((m = AWAIT_PROMISE.exec(code)) !== null) {
        const span = argSpan(code, m.index + m[0].length - 1)
        if (span && TIMER_INSIDE.test(code.slice(span.from, span.to))) offsets.push(m.index)
    }
    offsets.sort((a, b) => a - b)

    for (const off of offsets) {
        const line = lineOf(off)
        const text = lines[line - 1] || ''
        // Brace-less loop bodies are spans in the mask now, not a same-line
        // prefix test: a prefix test cannot tell the body of `while (...) await
        // sleep(100);` from the separate settle that follows it on the line.
        // An unbalanced parse means the mask cannot be trusted, so count the
        // site rather than let a scanner defect quietly lower the baseline.
        const inLoop = balanced && mask[off] === 1
        if (!inLoop) hits.push({ file: name, line, text: text.trim() })
    }
    return { hits, balanced }
}

function scanFile(file) {
    return scanSource(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file))
}

function writeBaseline(hits) {
    // Keep the committed note: it carries the ratchet's history, which a
    // fixed string here would silently truncate on every rewrite.
    const prior = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')).note : null
    fs.writeFileSync(BASELINE, JSON.stringify({
        check: 'fixed-settle sleep call sites under test/',
        note: prior || ('Ratchet only. Lower this when waits are converted to condition waits; never raise it. '
            + 'Raised once, 26 to 38, when the detector was widened to read the inline '
            + '`await new Promise(r => setTimeout(r, n))` form alongside `await sleep(n)`: that rise '
            + 'was the gate seeing a shape it had been blind to, not new debt.'),
        count: hits.length,
    }, null, 4) + '\n')
    console.log(`wrote ${BASELINE_REL}: ${hits.length}`)
    return 0
}

function main() {
    const args  = process.argv.slice(2)
    const files = walk(SCAN_DIR, []).sort()
    let hits = []
    const unbalanced = []
    for (const f of files) {
        const r = scanFile(f)
        if (!r.balanced) unbalanced.push(path.relative(ROOT, f))
        hits = hits.concat(r.hits)
    }

    if (args.includes('--list')) hits.forEach((h) => console.log(`${h.file}:${h.line}  ${h.text}`))

    if (args.includes('--write-baseline')) return writeBaseline(hits)

    if (!fs.existsSync(BASELINE)) {
        console.error(`sleep-flake: missing ${BASELINE_REL}; run: node bin/check-sleep-flake.js --write-baseline`)
        return 1
    }
    const baselineResult = readBaseline(BASELINE, BASELINE_REL)
    if (!baselineResult.ok) {
        console.error('sleep-flake: ' + baselineResult.error)
        return 1
    }
    const baseline = baselineResult.count

    if (unbalanced.length) {
        console.error('sleep-flake: brace scan did not balance in these files, so their sleeps were all counted:')
        unbalanced.forEach((f) => console.error(`  ${f}`))
    }

    if (hits.length > baseline) {
        console.error(`sleep-flake: ${hits.length} fixed-settle sleep call sites, baseline ${baseline}.`)
        console.error('A fixed `await sleep(n)` or `await new Promise(r => setTimeout(r, n))` before an')
        console.error('assertion passes or fails on how busy the venue is.')
        console.error('Wait on the condition instead: `_waitFor` in src/db/wait.js and its `waitForX` wrappers in src/db/*.js, or')
        console.error('the poll helpers in test/helpers/stakeHelper.js. Poll-interval sleeps inside a loop')
        console.error('that re-checks a condition are not counted and need no change.')
        // Which site is new cannot be told from a list of every site, so print
        // the count and the command rather than 100 lines of unchanged debt.
        console.error('List every counted site: node bin/check-sleep-flake.js --list')
        return 1
    }

    if (hits.length < baseline) {
        console.log(`sleep-flake: ${hits.length} fixed-settle sleep call sites, below the baseline of ${baseline}.`)
        console.log(`Lower it: node bin/check-sleep-flake.js --write-baseline`)
        return 0
    }

    console.log(`sleep-flake: ${hits.length} fixed-settle sleep call sites, at the baseline of ${baseline}.`)
    return 0
}

if (require.main === module) process.exit(main())

module.exports = { blankNonCode, loopMask, scanSource, scanFile, main }
