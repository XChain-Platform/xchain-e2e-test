/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict'

const { templateInterpolations } = require('./template_literal')
const { bodyCanExit, counterOnlyTest } = require('./loop_shape')

function blankRange(out, from, to) {
    for (let index = from; index < to && index < out.length; index++) {
        if (out[index] !== '\n') out[index] = ' '
    }
}

function regexLiteralEnd(src, out, index) {
    let previousIndex = index - 1
    while (previousIndex >= 0 && /\s/.test(out[previousIndex])) previousIndex -= 1
    const previous = previousIndex >= 0 ? out[previousIndex] : ''
    const word = src.slice(Math.max(0, previousIndex - 9), previousIndex + 1)
    if (!(previousIndex < 0 || '(,=:[!&|?{};+-*%^~'.includes(previous) ||
        /\b(?:return|typeof|case|in|of|do|else|yield|await)$/.test(word))) return -1
    let end = index + 1
    let inClass = false
    while (end < src.length && src[end] !== '\n') {
        if (src[end] === '\\') { end += 2; continue }
        if (src[end] === '[') inClass = true
        else if (src[end] === ']') inClass = false
        else if (src[end] === '/' && !inClass) return end + 1
        end += 1
    }
    return -1
}

function lexedRegexEnd(src, regexEnds, index) {
    return regexEnds.has(index) ? src.lastIndexOf('/', regexEnds.get(index) - 1) + 1 : -1
}

function blankRangeNonCode(src, out, from, to, regexEnds) {
    let index = from
    while (index < to) {
        const current = src[index]
        const next = src[index + 1]
        if (current === '/' && next === '/') {
            const end = src.indexOf('\n', index)
            const stop = end === -1 ? src.length : end
            blankRange(out, index, Math.min(stop, to)); index = Math.min(stop, to); continue
        }
        if (current === '/' && next === '*') {
            const end = src.indexOf('*/', index + 2)
            const stop = end === -1 ? src.length : end + 2
            blankRange(out, index, Math.min(stop, to)); index = Math.min(stop, to); continue
        }
        if (current === '/') {
            const end = regexEnds ? lexedRegexEnd(src, regexEnds, index) : regexLiteralEnd(src, out, index)
            if (end !== -1) {
                blankRange(out, index + 1, Math.min(end - 1, to)); index = Math.min(end, to); continue
            }
        }
        if (current === '`') {
            const template = templateInterpolations(src, index)
            const stop = Math.min(template.end, to)
            let literalStart = index + 1
            for (const part of template.parts) {
                if (part.codeStart >= stop) break
                blankRange(out, literalStart, Math.min(part.codeStart, stop))
                blankRangeNonCode(src, out, part.codeStart, Math.min(part.codeEnd, stop), part.regexEnds)
                literalStart = Math.min(part.codeEnd, stop)
            }
            const close = src[stop - 1] === '`' ? stop - 1 : stop
            blankRange(out, literalStart, close); index = stop; continue
        }
        if (current === '"' || current === "'") {
            let end = index + 1
            while (end < src.length) {
                if (src[end] === '\\') { end += 2; continue }
                if (src[end] === current) break
                end += 1
            }
            const stop = Math.min(end + 1, to)
            blankRange(out, index + 1, Math.min(end, to)); index = stop; continue
        }
        index += 1
    }
}

function blankNonCode(src) {
    const out = src.split('')
    blankRangeNonCode(src, out, 0, src.length)
    return out.join('')
}

function openParenOf(code, close) {
    let depth = 0
    for (let index = close; index >= 0; index--) {
        if (code[index] === ')') depth += 1
        else if (code[index] === '(') { depth -= 1; if (depth === 0) return index }
    }
    return -1
}

function closeBraceOf(code, open) {
    let depth = 0
    for (let index = open; index < code.length; index++) {
        if (code[index] === '{') depth += 1
        else if (code[index] === '}') { depth -= 1; if (depth === 0) return index }
    }
    return code.length
}

function forClauses(header) {
    const clauses = []
    let depth = 0
    let from = 0
    for (let index = 0; index < header.length; index++) {
        const current = header[index]
        if (current === '(' || current === '[' || current === '{') depth += 1
        else if (current === ')' || current === ']' || current === '}') depth -= 1
        else if (current === ';' && depth === 0) {
            clauses.push(header.slice(from, index)); from = index + 1
        }
    }
    clauses.push(header.slice(from))
    return clauses
}

function loopPolls(kind, header, body) {
    if (kind === 'iteration') return false
    let test = header
    let indexedData = false
    if (kind === 'for') {
        const clauses = forClauses(header)
        test = clauses.length >= 2 ? clauses[1] : ''
        indexedData = counterOnlyTest(clauses)
    }
    const trimmed = test.trim()
    if (trimmed && !indexedData && !/^(?:true|1|!0)$/.test(trimmed)) return true
    return bodyCanExit(body)
}

function loopKind(before, header) {
    if (!/\bfor(?:\s+await)?\s*$/.test(before)) return 'while'
    if (forClauses(header).length >= 2) return 'for'
    return 'iteration'
}

function classifyLoopBlock(code, index, inLoop) {
    let previousIndex = index - 1
    while (previousIndex >= 0 && /\s/.test(code[previousIndex])) previousIndex -= 1
    if (previousIndex >= 0 && code[previousIndex] === '>' && code[previousIndex - 1] === '=') return false
    const keyword = code.slice(Math.max(0, previousIndex - 11), previousIndex + 1)
    if (previousIndex >= 0 && code[previousIndex] === ')') {
        const open = openParenOf(code, previousIndex)
        if (open === -1) return inLoop
        const before = code.slice(Math.max(0, open - 12), open)
        if (/\b(?:while|for)(?:\s+await)?\s*$/.test(before)) {
            const header = code.slice(open + 1, previousIndex)
            const body = code.slice(index + 1, closeBraceOf(code, index))
            return loopPolls(loopKind(before, header), header, body)
        }
        return /\b(?:if|switch|catch|with)\s*$/.test(before) ? inLoop : false
    }
    if (/\bdo\s*$/.test(keyword)) {
        const end = closeBraceOf(code, index)
        const body = code.slice(index + 1, end)
        const tail = /^\s*while\s*\(/.exec(code.slice(end + 1))
        let test = ''
        if (tail) {
            const open = end + tail[0].length
            let depth = 0
            for (let cursor = open; cursor < code.length; cursor++) {
                if (code[cursor] === '(') depth += 1
                else if (code[cursor] === ')') {
                    depth -= 1
                    if (depth === 0) { test = code.slice(open + 1, cursor); break }
                }
            }
        }
        return loopPolls('while', test, body)
    }
    return inLoop
}

function markBracelessLoops(code, mask) {
    for (let index = 0; index < code.length; index++) {
        if (code[index] !== '(') continue
        const before = code.slice(Math.max(0, index - 12), index)
        if (!/\b(?:while|for)(?:\s+await)?\s*$/.test(before)) continue
        let depth = 0
        let close = -1
        for (let cursor = index; cursor < code.length; cursor++) {
            if (code[cursor] === '(') depth += 1
            else if (code[cursor] === ')') { depth -= 1; if (depth === 0) { close = cursor; break } }
        }
        if (close === -1) continue
        let bodyStart = close + 1
        while (bodyStart < code.length && /\s/.test(code[bodyStart])) bodyStart += 1
        if (code[bodyStart] === '{') continue
        let nesting = 0
        let end = bodyStart
        for (; end < code.length; end++) {
            const current = code[end]
            if ('([{'.includes(current)) nesting += 1
            else if (')]}'.includes(current)) { if (nesting === 0) break; nesting -= 1 }
            else if (nesting === 0 && (current === ';' || current === '\n')) break
        }
        const header = code.slice(index + 1, close)
        if (!loopPolls(loopKind(before, header), header, code.slice(bodyStart, end))) continue
        for (let cursor = bodyStart; cursor < end; cursor++) mask[cursor] = 1
    }
}

function loopMask(code) {
    const mask = new Uint8Array(code.length)
    const stack = []
    let depth = 0
    let inLoop = false
    for (let index = 0; index < code.length; index++) {
        if (code[index] === '{') {
            const effective = classifyLoopBlock(code, index, inLoop)
            stack.push(effective); depth += 1; inLoop = effective
        } else if (code[index] === '}') {
            stack.pop(); depth -= 1; inLoop = stack.length ? stack[stack.length - 1] : false
        } else if (inLoop) {
            mask[index] = 1
        }
    }
    markBracelessLoops(code, mask)
    return { mask, balanced: depth === 0 }
}

module.exports = { blankNonCode, loopMask }
