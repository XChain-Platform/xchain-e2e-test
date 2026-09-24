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
 * Request-row commit-barrier gate.
 *
 * A finalized mirror row does not prove that a venue indexer has committed
 * the source block that emitted the request. Before reading a request row, a
 * test must wait for that indexer to commit a request-related height. The wait
 * must dominate the read on the same control-flow path.
 *
 * A deliberately early read must explain itself on the call line or in the
 * contiguous comment block above it:
 *
 *     // request-row-wait-ok: absence is the assertion in this poll.
 *
 * Usage: node scripts/check-request-row-wait.js [--list] [path ...]
 *
 ********************************************************************/

'use strict'

const fs   = require('fs')
const path = require('path')

const ROOT         = path.join(__dirname, '..')
const DEFAULT_PATH = path.join(ROOT, 'test', 'attestMirror')
const OPT_OUT      = /\/\/\s*request-row-wait-ok:\s*\S/

function slash (value) { return value.split(path.sep).join('/') }

// Blank comments and literals without changing offsets. The scanner only
// needs identifiers, punctuation and braces; keeping offsets stable preserves
// exact source lines in the report.
function blankNonCode (src) {
    const out = src.split('')
    const blank = (from, to) => {
        for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' '
    }
    let i = 0
    while (i < src.length) {
        const c = src[i]
        const d = src[i + 1]
        if (c === '/' && d === '/') {
            const end = src.indexOf('\n', i)
            const stop = end === -1 ? src.length : end
            blank(i, stop); i = stop; continue
        }
        if (c === '/' && d === '*') {
            const end = src.indexOf('*/', i + 2)
            const stop = end === -1 ? src.length : end + 2
            blank(i, stop); i = stop; continue
        }
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1
            while (j < src.length) {
                if (src[j] === '\\') { j += 2; continue }
                if (src[j] === c) break
                j++
            }
            blank(i, Math.min(j + 1, src.length)); i = j + 1; continue
        }
        i++
    }
    return out.join('')
}

function lineAt (src, offset) {
    let line = 1
    for (let i = 0; i < offset; i++) if (src[i] === '\n') line++
    return line
}

function splitArgs (code, open) {
    const args = []
    let from = open + 1
    let depth = 1
    for (let i = open + 1; i < code.length; i++) {
        const c = code[i]
        if (c === '(' || c === '[' || c === '{') depth++
        else if (c === ')' || c === ']' || c === '}') {
            depth--
            if (depth === 0) {
                args.push(code.slice(from, i).trim())
                return { args, end: i }
            }
        } else if (c === ',' && depth === 1) {
            args.push(code.slice(from, i).trim())
            from = i + 1
        }
    }
    return null
}

function aliasesFor (code, canonical) {
    const names = new Set([canonical])
    const re = new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;\\n]*\\b' + canonical + '\\b', 'g')
    let match
    while ((match = re.exec(code))) names.add(match[1])
    return names
}

function callsFor (code, names) {
    const escaped = [...names].map((n) => n.replace(/[$]/g, '\\$&')).join('|')
    const re = new RegExp('\\b(' + escaped + ')\\s*\\(', 'g')
    const calls = []
    let match
    while ((match = re.exec(code))) {
        const prefix = code.slice(Math.max(0, match.index - 30), match.index)
        if (/function\s*$/.test(prefix)) continue
        const open = code.indexOf('(', match.index + match[1].length)
        const parsed = splitArgs(code, open)
        if (!parsed) continue
        calls.push({ name: match[1], offset: match.index, end: parsed.end, args: parsed.args })
        re.lastIndex = parsed.end + 1
    }
    return calls
}

function blockKind (code, open) {
    const prefix = code.slice(Math.max(0, open - 300), open)
    if (/\b(?:for|while)\s*\([^{}]*\)\s*$/.test(prefix) || /\bdo\s*$/.test(prefix)) return 'loop'
    if (/\b(?:if|else|switch|catch|try|finally)\b[^{}]*$/.test(prefix)) return 'branch'
    if (/(?:=>|\bfunction\b)[^{}]*$/.test(prefix)) return 'function'
    return 'block'
}

function blocksOf (code) {
    const blocks = []
    const stack = []
    for (let i = 0; i < code.length; i++) {
        if (code[i] === '{') {
            const block = { id: blocks.length, open: i, close: code.length, kind: blockKind(code, i) }
            blocks.push(block)
            stack.push(block)
        } else if (code[i] === '}' && stack.length) {
            stack.pop().close = i
        }
    }
    return blocks
}

function ancestry (blocks, offset) {
    return blocks.filter((b) => b.open < offset && offset < b.close)
}

function assignmentsOf (code) {
    const assignments = []
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g
    let match
    while ((match = re.exec(code))) assignments.push({ name: match[1], rhs: match[2].trim(), offset: match.index })
    return assignments
}

function unwrap (expr) {
    let value = expr.trim()
    let changed = true
    while (changed) {
        changed = false
        const wrapper = /^(?:Number|String)\s*\((.*)\)$/.exec(value)
        if (wrapper) { value = wrapper[1].trim(); changed = true; continue }
        const guarded = /^(?:[A-Za-z_$][\w$]*\s*&&\s*)?([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)$/.exec(value)
        if (guarded) value = guarded[1]
    }
    return value
}

function resolveExpr (expr, assignments, before, seen) {
    const trail = seen || new Set()
    let value = unwrap(expr)
    if (!/^[A-Za-z_$][\w$]*$/.test(value) || trail.has(value)) return value
    const prior = assignments.filter((a) => a.name === value && a.offset < before).pop()
    if (!prior) return value
    trail.add(value)
    return resolveExpr(prior.rhs, assignments, prior.offset, trail)
}

function rootAndProperty (expr) {
    const members = [...expr.matchAll(/\b([A-Za-z_$][\w$]*)\.(blockIndex|requestBlock|deadlineBlock|appliedBlock|requestId)\b/g)]
    return members.length ? { root: members[0][1], property: members[0][2] } : null
}

function requestRelatedHeight (heightArg, requestArg, assignments, before) {
    const height = resolveExpr(heightArg, assignments, before)
    const request = resolveExpr(requestArg, assignments, before)
    const hMember = rootAndProperty(height)
    const rMember = rootAndProperty(request)
    if (hMember && rMember && hMember.root === rMember.root && rMember.property === 'requestId') return true
    if (/^(?:blockIndex|requestBlock)$/.test(height) && /^(?:requestId|id)$/.test(request)) return true
    return false
}

function sameIndexer (wait, read, src) {
    const left = (wait.args[1] || '').replace(/\s+/g, '')
    const right = (read.args[1] || '').replace(/\s+/g, '')
    if (left === right) return true
    const lineStart = src.lastIndexOf('\n', wait.offset) + 1
    const line = src.slice(lineStart, src.indexOf('\n', wait.offset) === -1 ? src.length : src.indexOf('\n', wait.offset))
    return /for\s*\(\s*const\s+ix\s+of\s+venue\.indexers\s*\)/.test(line) && left === 'ix.index'
}

function dominates (wait, read) {
    if (wait.offset >= read.offset) return false
    const readIds = new Set(read.ancestry.map((b) => b.id))
    return wait.ancestry.every((b) => readIds.has(b.id))
}

function markerFor (lines, lineNumber) {
    const own = lines[lineNumber - 1] || ''
    if (OPT_OUT.test(own)) return own.trim()
    for (let i = lineNumber - 2; i >= 0 && /^\s*\/\//.test(lines[i]); i--) {
        if (OPT_OUT.test(lines[i])) return lines[i].trim()
    }
    return null
}

function scanSource (src, rel) {
    const code = blankNonCode(src)
    const lines = src.split('\n')
    const blocks = blocksOf(code)
    const assignments = assignmentsOf(code)
    const readAliases = aliasesFor(code, 'readRequestRow')
    const waitAliases = aliasesFor(code, 'waitForHeightWithClear')
    const waits = callsFor(code, waitAliases).filter((c) => c.args.length >= 3).map((call) => ({
        ...call,
        line: lineAt(src, call.offset),
        ancestry: ancestry(blocks, call.offset),
    }))
    const reads = callsFor(code, readAliases).filter((c) => c.args.length >= 3).map((call) => ({
        ...call,
        file: rel,
        line: lineAt(src, call.offset),
        identifier: (call.args[2] || '').replace(/\s+/g, ' ').trim(),
        ancestry: ancestry(blocks, call.offset),
    }))

    return reads.map((read) => {
        const marker = markerFor(lines, read.line)
        if (marker) return { ...read, status: 'exception', reason: marker }
        const guard = waits.filter((wait) => dominates(wait, read) && sameIndexer(wait, read, src) &&
            requestRelatedHeight(wait.args[2], read.args[2], assignments, read.offset)).pop()
        if (!guard) return { ...read, status: 'unguarded', reason: 'no dominating request-related indexer-height wait' }
        const readLoops = read.ancestry.filter((b) => b.kind === 'loop')
        const waitLoops = new Set(guard.ancestry.filter((b) => b.kind === 'loop').map((b) => b.id))
        const loopDominance = readLoops.some((b) => !waitLoops.has(b.id))
        return {
            ...read,
            status: 'guarded',
            reason: 'height wait at ' + rel + ':' + guard.line +
                (loopDominance ? ' dominates the enclosing loop' : ' dominates this read') +
                ' and targets ' + guard.args[2].replace(/\s+/g, ' ').trim(),
        }
    })
}

function collectFiles (inputs) {
    const files = []
    const missing = []
    const walk = (entry) => {
        if (!fs.existsSync(entry)) { missing.push(entry); return }
        const stat = fs.statSync(entry)
        if (stat.isDirectory()) {
            for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
                if (child.isDirectory()) walk(path.join(entry, child.name))
                else if (child.isFile() && child.name.endsWith('.js')) files.push(path.join(entry, child.name))
            }
        } else if (stat.isFile() && entry.endsWith('.js')) files.push(entry)
    }
    inputs.forEach((entry) => walk(path.resolve(entry)))
    return { files: [...new Set(files)].sort(), missing }
}

function scanPaths (inputs) {
    const collected = collectFiles(inputs)
    const calls = []
    for (const file of collected.files) {
        const rel = slash(path.relative(ROOT, file))
        calls.push(...scanSource(fs.readFileSync(file, 'utf8'), rel))
    }
    return {
        files: collected.files,
        missing: collected.missing,
        calls,
        guarded: calls.filter((c) => c.status === 'guarded'),
        unguarded: calls.filter((c) => c.status === 'unguarded'),
        exceptions: calls.filter((c) => c.status === 'exception'),
    }
}

function printResult (result) {
    console.log('request-row-wait: files-read ' + result.files.length + ', call-sites-read ' + result.calls.length)
    for (const hit of result.calls) {
        console.log(hit.status.toUpperCase() + ' ' + hit.file + ':' + hit.line +
            ' identifier=' + hit.identifier + ' - ' + hit.reason)
    }
    console.log('request-row-wait: guarded ' + result.guarded.length + ', unguarded ' +
        result.unguarded.length + ', acknowledged-exceptions ' + result.exceptions.length)
}

function main (argv) {
    const args = argv.filter((arg) => arg !== '--list')
    const inputs = args.length ? args : [DEFAULT_PATH]
    const result = scanPaths(inputs)
    if (result.missing.length) {
        result.missing.forEach((entry) => console.error('request-row-wait: input path does not exist: ' + entry))
        return 2
    }
    if (!result.files.length) {
        console.error('request-row-wait: refused: read zero files from the supplied input')
        return 2
    }
    if (!result.calls.length) {
        console.error('request-row-wait: refused: read ' + result.files.length +
            ' file(s) but found zero request-row reads')
        return 2
    }
    printResult(result)
    if (result.unguarded.length) {
        console.error('request-row-wait: every unguarded read needs a request-block commit wait or an explained marker')
        return 1
    }
    return 0
}

module.exports = { blankNonCode, collectFiles, scanPaths, scanSource }

if (require.main === module) process.exit(main(process.argv.slice(2)))
