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
 * catch up. Two shapes of wait exist here and only one of them is flaky:
 *
 *   POLL INTERVAL - `await sleep(n)` as the last step of a loop that re-checks
 *   a condition and returns early. Deterministic: the loop exits as soon as the
 *   condition holds, and the sleep only bounds how often it asks. Not counted.
 *
 *   FIXED SETTLE - a standalone `await sleep(n)` used to "give the system time"
 *   before an assertion. Flaky by construction: it passes or fails on how busy
 *   the venue is. Counted.
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

// Only test/ is scanned. claude/scratch/ is tracked but no npm script runs it,
// so ratcheting one-off drill scripts would tax throwaway work for no CI gain.
const WAIT_CALL = /\b(?:sleep|delay)\s*\(/

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

// Walk the code and mark, per character offset, whether it sits inside a loop
// body. Only brace-bodied while/for/do loops are tracked; a one-line loop body
// is handled by the same-line fallback in scanFile.
function loopMask(code) {
    const mask = new Uint8Array(code.length)
    const openLoopBodies = []   // brace depths at which a loop body opened
    const pendingLoop    = []   // paren depths of loop headers being consumed
    let depth = 0
    let paren = 0
    for (let i = 0; i < code.length; i++) {
        const c = code[i]
        if (c === '(') {
            const before = code.slice(Math.max(0, i - 12), i)
            if (/\b(?:while|for)\s*$/.test(before)) pendingLoop.push(paren)
            paren++
            continue
        }
        if (c === ')') {
            paren--
            if (pendingLoop.length && pendingLoop[pendingLoop.length - 1] === paren) {
                // Header consumed; the next `{` (if any) opens this loop's body.
                pendingLoop.pop()
                const rest = code.slice(i + 1)
                const nextTok = /^\s*\{/.exec(rest)
                if (nextTok) openLoopBodies.push({ depth, armed: false })
            }
            continue
        }
        if (c === '{') {
            depth++
            const top = openLoopBodies[openLoopBodies.length - 1]
            if (top && !top.armed && top.depth === depth - 1) top.armed = true
            continue
        }
        if (c === '}') {
            const top = openLoopBodies[openLoopBodies.length - 1]
            if (top && top.armed && top.depth === depth - 1) openLoopBodies.pop()
            depth--
            continue
        }
        // `do {` has no header parens: arm it when the brace follows the keyword.
        if (c === 'd' && /^do\s*\{/.test(code.slice(i, i + 8)) && !/\w/.test(code[i - 1] || ' ')) {
            openLoopBodies.push({ depth, armed: false })
            continue
        }
        if (openLoopBodies.some((l) => l.armed)) mask[i] = 1
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

function scanFile(file) {
    const src  = fs.readFileSync(file, 'utf8')
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
    const re = /\bawait\s+(?:sleep|delay)\s*\(/g
    let m
    while ((m = re.exec(code)) !== null) {
        const off  = m.index
        const line = lineOf(off)
        const text = src.split('\n')[line - 1] || ''
        // Same-line brace-less loop body: `while (...) await sleep(n)`.
        const sameLineLoop = /\b(?:while|for)\s*\(/.test(text.slice(0, text.search(WAIT_CALL)))
        // An unbalanced parse means the mask cannot be trusted, so count the
        // site rather than let a scanner defect quietly lower the baseline.
        const inLoop = balanced && (mask[off] === 1 || sameLineLoop)
        if (!inLoop) hits.push({ file: path.relative(ROOT, file), line, text: text.trim() })
    }
    return { hits, balanced }
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
            note: 'Ratchet only. Lower this when sleeps are converted to condition waits; never raise it.',
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
        console.error('A fixed `await sleep(n)` before an assertion passes or fails on how busy the venue is.')
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

process.exit(main())
