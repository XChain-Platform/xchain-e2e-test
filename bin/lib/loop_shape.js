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
 * Loop-shape reads for the sleep-flake gate, over code whose comments,
 * strings and template text are already blanked to spaces.
 *
 * Two questions decide whether a wait inside a loop is a poll interval: does
 * the loop's test re-check anything, and can its body leave the loop. Both
 * are answered here from the text alone, so the gate stays runnable before
 * npm install.
 *
 ********************************************************************/

'use strict'

const NAME  = '[A-Za-z_$][\\w$]*'
const ATOM  = `(?:${NAME}|(?:\\d+(?:\\.\\d*)?|\\.\\d+))`
const BOUND = new RegExp(`^${ATOM}(?:\\s*(?:\\.\\s*${NAME}|\\[\\s*${ATOM}\\s*\\]|[+\\-*/%]\\s*${ATOM}))*$`)

// Identifiers, member reads, numbers and plain arithmetic: nothing a read can change.
function sideEffectFreeBound(bound) {
    return BOUND.test(bound.trim())
}

function loopCounter(init) {
    const match = new RegExp(`^(?:(?:let|const|var)\\s+)?(${NAME})\\s*=`).exec(init.trim())
    return match ? match[1] : null
}

function updatesCounter(step, counter) {
    const name = counter.replace(/\$/g, '\\$')
    const text = step.trim()
    if (new RegExp(`^(?:(?:\\+\\+|--)\\s*${name}|${name}\\s*(?:\\+\\+|--))$`).test(text)) return true
    const assignment = new RegExp(`^${name}\\s*[+\\-]=\\s*(.+)$`).exec(text)
    return !!assignment && sideEffectFreeBound(assignment[1])
}

// True when a three-clause `for` header only steps its own counter towards a
// fixed bound, `for (let i = 0; i < cases.length; i++)`: that test re-checks
// nothing, so the loop is data iteration unless its body can exit.
function counterOnlyTest(clauses) {
    if (clauses.length !== 3) return false
    const counter = loopCounter(clauses[0])
    if (!counter || !updatesCounter(clauses[2], counter)) return false
    const comparison = /^(.*?)\s*(<=|>=|!==|!=|<|>)\s*(.*?)$/.exec(clauses[1].trim())
    if (!comparison) return false
    const left = comparison[1].trim(), right = comparison[3].trim()
    return (left === counter && sideEffectFreeBound(right)) ||
        (right === counter && sideEffectFreeBound(left))
}

function closeOf(code, open, opener, closer) {
    let depth = 0
    for (let i = open; i < code.length; i++) {
        if (code[i] === opener) depth++
        else if (code[i] === closer && --depth === 0) return i
    }
    return code.length
}

function openOf(code, close) {
    let depth = 0
    for (let i = close; i >= 0; i--) {
        if (code[i] === ')') depth++
        else if (code[i] === '(' && --depth === 0) return i
    }
    return -1
}

// End of the one statement a brace-less loop body holds.
function statementEnd(code, from) {
    let nest = 0, end = from
    for (; end < code.length; end++) {
        const ch = code[end]
        if ('([{'.includes(ch)) nest++
        else if (')]}'.includes(ch)) { if (nest === 0) break; nest-- }
        else if (nest === 0 && (ch === ';' || ch === '\n')) break
    }
    return end
}

const LOOP_HEAD = /\b(?:while|for)(?:\s+await)?\s*$/

// What the `{` at `i` opens: a function, a construct an unlabelled `break`
// stops at, a `try` block with a `catch`, or null for any other block.
function braceKind(code, i) {
    let p = i - 1
    while (p >= 0 && /\s/.test(code[p])) p--
    if (/\btry$/.test(code.slice(Math.max(0, p - 3), p + 1)))
        return /^\s*catch\b/.test(code.slice(closeOf(code, i, '{', '}') + 1)) ? 'caught' : null
    if (code[p] === '>' && code[p - 1] === '=') return 'function'
    if (code[p] === ')') {
        const open = openOf(code, p)
        if (open === -1) return null
        const before = code.slice(Math.max(0, open - 12), open)
        if (LOOP_HEAD.test(before) || /\bswitch\s*$/.test(before)) return 'breakable'
        return /\b(?:if|catch|with)\s*$/.test(before) ? null : 'function'
    }
    return /\bdo\s*$/.test(code.slice(Math.max(0, p - 2), p + 1)) ? 'breakable' : null
}

function innerScopes(body) {
    const spans = []
    for (let i = 0; i < body.length; i++) {
        if (body[i] === '{') {
            const kind = braceKind(body, i)
            if (kind) spans.push({ kind, from: i, to: closeOf(body, i, '{', '}') })
        } else if (body[i] === '(' && LOOP_HEAD.test(body.slice(Math.max(0, i - 12), i))) {
            let b = closeOf(body, i, '(', ')') + 1
            while (b < body.length && /\s/.test(body[b])) b++
            if (body[b] !== '{') spans.push({ kind: 'breakable', from: b, to: statementEnd(body, b) })
        }
    }
    return spans
}

// True when the body can leave the loop it belongs to. A `return` or `throw`
// inside a nested function leaves only that function, a `throw` inside a `try`
// that has a `catch` is caught there, and an unlabelled `break` inside a nested
// loop or switch leaves only that construct, so none of them earns the loop a
// poll exemption. A labelled `break` leaves this loop unless its label is
// declared inside the body. `continue`, labelled or not, never leaves it.
function bodyCanExit(body) {
    const spans = innerScopes(body)
    const within = (at, kind) => spans.some((s) => s.kind === kind && s.from < at && at < s.to)
    const labels = new Set()
    const labelRe = new RegExp(`(${NAME})\\s*:\\s*(?=(?:for|while|do|switch)\\b|\\{)`, 'g')
    let m
    while ((m = labelRe.exec(body)) !== null) labels.add(m[1])
    const exitRe = new RegExp(`\\b(break|return|throw)\\b(?:[ \\t]+(${NAME}))?`, 'g')
    while ((m = exitRe.exec(body)) !== null) {
        if (/\.\s*$/.test(body.slice(Math.max(0, m.index - 8), m.index))) continue
        if (within(m.index, 'function')) continue
        const [, word, label] = m
        if (word === 'return') return true
        if (word === 'throw') { if (!within(m.index, 'caught')) return true; continue }
        if (label) { if (!labels.has(label)) return true; continue }
        if (!within(m.index, 'breakable')) return true
    }
    return false
}

module.exports = { bodyCanExit, counterOnlyTest }
