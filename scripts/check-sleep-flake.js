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
 * catch up. A wait is written two ways here, `await sleep(n)` (the helper form)
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
 * already exist (src/db.js `_waitFor` and its `waitForX` wrappers,
 * test/helpers/stakeHelper.js).
 *
 * Usage:  node scripts/check-sleep-flake.js [--list] [--write-baseline]
 *
 ********************************************************************/

'use strict'

const fs   = require('fs')
const path = require('path')

const ROOT         = path.join(__dirname, '..')
const SCAN_DIR     = path.join(ROOT, 'test')
const BASELINE_REL = path.join('scripts', 'sleep-flake-baseline.json')
const BASELINE     = path.join(ROOT, BASELINE_REL)

// Only test/ is scanned. One-off drill scripts tracked outside it have no npm
// script running them, so ratcheting them would tax throwaway work for no CI gain.

// The two spellings of an awaited wait. Reading only the helper form left the
// inline one ungated: the shared indexer helpers (orderHelper, swapHelper,
// dispenserHelper) and the oracleBatch settles are all written that way, so a
// new wait of that shape could land without the count moving at all.
const AWAIT_SLEEP   = /\bawait\s+(?:sleep|delay)\s*\(/g
const AWAIT_PROMISE = /\bawait\s+new\s+Promise\s*\(/g

// An awaited promise is a wait on a DURATION only when a timer resolves it.
// Two neighbouring shapes deliberately fall outside this: an event wait
// (`await new Promise(r => ws.on('open', r))`) resolves on a condition, and a
// `Promise.race` timeout arm carries no `await` of its own, so neither the
// helper definitions (`const sleep = (ms) => new Promise(...)`) nor the race
// arms reach the detector at all.
const TIMER_INSIDE  = /\bsetTimeout\s*\(/

// Blank out comments, strings and template literals so brace counting and call
// detection see code only. Returns a same-length string (offsets stay valid).
function blankNonCode(src) {
    const out = src.split('')
    let i = 0
    const blank = (from, to) => {
        for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
    }
    while (i < src.length) {
        const c = src[i]
        const d = src[i + 1]
        if (c === '/' && d === '/') {
            const end = src.indexOf('\n', i); const stop = end === -1 ? src.length : end
            blank(i, stop); i = stop; continue
        }
        if (c === '/' && d === '*') {
            const end = src.indexOf('*/', i + 2); const stop = end === -1 ? src.length : end + 2
            blank(i, stop); i = stop; continue
        }
        // Regex literal, not division: decided by the previous code token. A
        // regex may legitimately contain quotes and braces, so mislexing one as
        // a string swallows the braces after it and unbalances the whole file.
        if (c === '/') {
            let p = i - 1
            while (p >= 0 && /\s/.test(out[p])) p--
            const prev = p >= 0 ? out[p] : ''
            const word = src.slice(Math.max(0, p - 9), p + 1)
            const regexOk = p < 0 || '(,=:[!&|?{};+-*%^~'.includes(prev)
                || /\b(?:return|typeof|case|in|of|do|else|yield|await)$/.test(word)
            if (regexOk) {
                let j = i + 1
                let inClass = false
                let closed = false
                while (j < src.length && src[j] !== '\n') {
                    if (src[j] === '\\') { j += 2; continue }
                    if (src[j] === '[') inClass = true
                    else if (src[j] === ']') inClass = false
                    else if (src[j] === '/' && !inClass) { closed = true; break }
                    j++
                }
                if (closed) { blank(i + 1, j); i = j + 1; continue }
            }
        }
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1
            while (j < src.length) {
                if (src[j] === '\\') { j += 2; continue }
                if (src[j] === c) break
                j++
            }
            blank(i + 1, j); i = j + 1; continue
        }
        i++
    }
    return out.join('')
}

// Index of the `(` matching the `)` at `close`, or -1. Counted over blanked code.
function openParenOf(code, close) {
    let d = 0
    for (let i = close; i >= 0; i--) {
        if (code[i] === ')') d++
        else if (code[i] === '(') { d--; if (d === 0) return i }
    }
    return -1
}

// Index of the `}` matching the `{` at `open`, or the end of the code.
function closeBraceOf(code, open) {
    let d = 0
    for (let i = open; i < code.length; i++) {
        if (code[i] === '{') d++
        else if (code[i] === '}') { d--; if (d === 0) return i }
    }
    return code.length
}

// Split a `for` header on its top-level semicolons: `i = 0`, the test, the step.
function forClauses(header) {
    const out = []
    let d = 0, from = 0
    for (let i = 0; i < header.length; i++) {
        const c = header[i]
        if (c === '(' || c === '[' || c === '{') d++
        else if (c === ')' || c === ']' || c === '}') d--
        else if (c === ';' && d === 0) { out.push(header.slice(from, i)); from = i + 1 }
    }
    out.push(header.slice(from))
    return out
}

// A loop earns the poll-interval exemption only when it RE-CHECKS something: a
// real (non-literal) test, or an early exit in its own body. Two shapes sit in a
// loop without being polls, so they count:
//   - data iteration, `for (const c of cases) { ... await sleep(n) }`: the loop
//     re-checks nothing, so the wait inside it is an ordinary fixed settle;
//   - `while (true) { await sleep(n) }` with no way out, which re-checks nothing
//     either and would spin forever if it were really a poll.
function loopPolls(kind, header, body) {
    if (kind === 'iteration') return false
    let test = header
    if (kind === 'for') {
        const clauses = forClauses(header)
        test = clauses.length >= 2 ? clauses[1] : ''
    }
    const t = test.trim()
    if (t && !/^(?:true|1|!0)$/.test(t)) return true
    // `for (;;)` / `while (true)` poll only if the body can leave.
    return /\b(?:break|return|throw)\b/.test(body)
}

// Classify the loop a header `(`..`)` pair belongs to, from its own text.
function loopKind(before, header) {
    if (!/\bfor(?:\s+await)?\s*$/.test(before)) return 'while'
    if (forClauses(header).length >= 2) return 'for'
    return 'iteration'   // for-of / for-in
}

// Walk the code and mark, per character offset, whether it sits inside the body
// of a POLLING loop. Three boundaries are load-bearing and each was a false
// negative before:
//   - a non-polling loop does not exempt (see loopPolls);
//   - a nested function body ends the exemption, so a callback that merely sits
//     in a loop body is not treated as part of the poll;
//   - a brace-less body stops at its own statement end, so the settle in
//     `while (!ready) await sleep(100); await sleep(5000)` is not swallowed by
//     the loop header that precedes it on the line.
function loopMask(code) {
    const mask = new Uint8Array(code.length)
    const stack = []          // one frame per open brace, carrying its effective state
    let depth  = 0
    let inLoop = false

    // What does the `{` at `i` open? Returns the effective in-a-polling-loop
    // state for everything inside it.
    const classify = (i) => {
        let p = i - 1
        while (p >= 0 && /\s/.test(code[p])) p--
        if (p >= 0 && code[p] === '>' && code[p - 1] === '=') return false          // arrow body
        const kw = code.slice(Math.max(0, p - 11), p + 1)
        if (p >= 0 && code[p] === ')') {
            const open = openParenOf(code, p)
            if (open === -1) return inLoop
            const before = code.slice(Math.max(0, open - 12), open)
            if (/\b(?:while|for)(?:\s+await)?\s*$/.test(before)) {
                const header = code.slice(open + 1, p)
                const body   = code.slice(i + 1, closeBraceOf(code, i))
                return loopPolls(loopKind(before, header), header, body)
            }
            // `if`/`else if`/`switch`/`catch` are transparent; anything else
            // ending in a parameter list is a function and ends the exemption.
            return /\b(?:if|switch|catch|with)\s*$/.test(before) ? inLoop : false
        }
        if (/\bdo\s*$/.test(kw)) {
            // `do { ... } while (test)`: the test sits AFTER the body, so read it
            // from the tail rather than from a header this loop shape has not got.
            const end  = closeBraceOf(code, i)
            const body = code.slice(i + 1, end)
            const tail = /^\s*while\s*\(/.exec(code.slice(end + 1))
            let test = ''
            if (tail) {
                const tOpen = end + tail[0].length          // index of the `(`
                let d = 0
                for (let j = tOpen; j < code.length; j++) {
                    if (code[j] === '(') d++
                    else if (code[j] === ')') { d--; if (d === 0) { test = code.slice(tOpen + 1, j); break } }
                }
            }
            return loopPolls('while', test, body)
        }
        if (/\b(?:else|try|finally)\s*$/.test(kw)) return inLoop
        return inLoop          // bare block, object literal, class body
    }

    for (let i = 0; i < code.length; i++) {
        const c = code[i]
        if (c === '{') {
            const eff = classify(i)
            stack.push(eff)
            depth++
            inLoop = eff
            continue
        }
        if (c === '}') {
            stack.pop()
            depth--
            inLoop = stack.length ? stack[stack.length - 1] : false
            continue
        }
        if (inLoop) mask[i] = 1
    }

    // Brace-less loop bodies, marked as their own spans: `while (...) await x()`.
    for (let i = 0; i < code.length; i++) {
        if (code[i] !== '(') continue
        const before = code.slice(Math.max(0, i - 12), i)
        if (!/\b(?:while|for)(?:\s+await)?\s*$/.test(before)) continue
        let d = 0, close = -1
        for (let j = i; j < code.length; j++) {
            if (code[j] === '(') d++
            else if (code[j] === ')') { d--; if (d === 0) { close = j; break } }
        }
        if (close === -1) continue
        let b = close + 1
        while (b < code.length && /\s/.test(code[b])) b++
        if (code[b] === '{') continue                       // braced body, handled above
        // The body is one statement: it ends at the first `;` or newline at
        // nesting depth zero, and NOT at the end of the line it started on.
        let nest = 0, end = b
        for (; end < code.length; end++) {
            const ch = code[end]
            if ('([{'.includes(ch)) nest++
            else if (')]}'.includes(ch)) { if (nest === 0) break; nest-- }
            else if (nest === 0 && (ch === ';' || ch === '\n')) break
        }
        const header = code.slice(i + 1, close)
        if (!loopPolls(loopKind(before, header), header, code.slice(b, end))) continue
        for (let k = b; k < end; k++) mask[k] = 1
    }

    return { mask, balanced: depth === 0 }
}

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

function scanSource(src, name) {
    const code = blankNonCode(src)
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
    AWAIT_SLEEP.lastIndex = 0
    while ((m = AWAIT_SLEEP.exec(code)) !== null) offsets.push(m.index)
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

    if (args.includes('--write-baseline')) {
        fs.writeFileSync(BASELINE, JSON.stringify({
            check: 'fixed-settle sleep call sites under test/',
            note: 'Ratchet only. Lower this when waits are converted to condition waits; never raise it. '
                + 'Raised once, 26 to 38, when the detector was widened to read the inline '
                + '`await new Promise(r => setTimeout(r, n))` form alongside `await sleep(n)`: that rise '
                + 'was the gate seeing a shape it had been blind to, not new debt.',
            count: hits.length,
        }, null, 4) + '\n')
        console.log(`wrote ${BASELINE_REL}: ${hits.length}`)
        return 0
    }

    if (!fs.existsSync(BASELINE)) {
        console.error(`sleep-flake: missing ${BASELINE_REL}; run: node scripts/check-sleep-flake.js --write-baseline`)
        return 1
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).count

    if (unbalanced.length) {
        console.error('sleep-flake: brace scan did not balance in these files, so their sleeps were all counted:')
        unbalanced.forEach((f) => console.error(`  ${f}`))
    }

    if (hits.length > baseline) {
        console.error(`sleep-flake: ${hits.length} fixed-settle sleep call sites, baseline ${baseline}.`)
        console.error('A fixed `await sleep(n)` or `await new Promise(r => setTimeout(r, n))` before an')
        console.error('assertion passes or fails on how busy the venue is.')
        console.error('Wait on the condition instead: src/db.js `_waitFor` and its `waitForX` wrappers, or')
        console.error('the poll helpers in test/helpers/stakeHelper.js. Poll-interval sleeps inside a loop')
        console.error('that re-checks a condition are not counted and need no change.')
        // Which site is new cannot be told from a list of every site, so print
        // the count and the command rather than 100 lines of unchanged debt.
        console.error('List every counted site: node scripts/check-sleep-flake.js --list')
        return 1
    }

    if (hits.length < baseline) {
        console.log(`sleep-flake: ${hits.length} fixed-settle sleep call sites, below the baseline of ${baseline}.`)
        console.log(`Lower it: node scripts/check-sleep-flake.js --write-baseline`)
        return 0
    }

    console.log(`sleep-flake: ${hits.length} fixed-settle sleep call sites, at the baseline of ${baseline}.`)
    return 0
}

if (require.main === module) process.exit(main())

module.exports = { blankNonCode, loopMask, scanSource, scanFile, main }
