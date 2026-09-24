#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_INPUTS = [path.join(ROOT, 'test', 'attestMirror')]
const TEST_FILE = /\.test\.js$/
const MOCHA_CALL = /\b(describe|context|suite|it|test|before|beforeEach|setup)(\.skip)?\s*\(/g
const HOOKS = new Set(['before', 'beforeEach', 'setup'])
const SUITES = new Set(['describe', 'context', 'suite'])
const TESTS = new Set(['it', 'test'])

function maskNonCode (source) {
    const out = source.split('')
    const blank = (from, to) => {
        for (let i = from; i < to && i < out.length; i++) {
            if (out[i] !== '\n') out[i] = ' '
        }
    }
    let i = 0
    while (i < source.length) {
        const c = source[i]
        const next = source[i + 1]
        if (c === '/' && next === '/') {
            const end = source.indexOf('\n', i)
            const stop = end === -1 ? source.length : end
            blank(i, stop)
            i = stop
            continue
        }
        if (c === '/' && next === '*') {
            const end = source.indexOf('*/', i + 2)
            const stop = end === -1 ? source.length : end + 2
            blank(i, stop)
            i = stop
            continue
        }
        if (c === '"' || c === "'" || c === '`') {
            const quote = c
            let end = i + 1
            while (end < source.length) {
                if (source[end] === '\\') {
                    end += 2
                    continue
                }
                if (source[end] === quote) {
                    end++
                    break
                }
                end++
            }
            blank(i, end)
            i = end
            continue
        }
        if (c === '/') {
            let previous = i - 1
            while (previous >= 0 && /\s/.test(out[previous])) previous--
            const prior = previous < 0 ? '' : out[previous]
            const word = source.slice(Math.max(0, previous - 9), previous + 1)
            const canStartRegex = previous < 0 || '(,=:[!&|?{};+-*%^~'.includes(prior) ||
                /\b(?:return|typeof|case|in|of|do|else|yield|await)$/.test(word)
            if (canStartRegex) {
                let end = i + 1
                let inClass = false
                let closed = false
                while (end < source.length && source[end] !== '\n') {
                    if (source[end] === '\\') {
                        end += 2
                        continue
                    }
                    if (source[end] === '[') inClass = true
                    else if (source[end] === ']') inClass = false
                    else if (source[end] === '/' && !inClass) {
                        end++
                        while (/[a-z]/i.test(source[end] || '')) end++
                        closed = true
                        break
                    }
                    end++
                }
                if (closed) {
                    blank(i, end)
                    i = end
                    continue
                }
            }
        }
        i++
    }
    return out.join('')
}

function closeBrace (masked, open) {
    let depth = 0
    for (let i = open; i < masked.length; i++) {
        if (masked[i] === '{') depth++
        else if (masked[i] === '}') {
            depth--
            if (depth === 0) return i
        }
    }
    return masked.length
}

function lineAt (source, offset) {
    return source.slice(0, offset).split('\n').length
}

function stringAt (source, offset) {
    let i = offset
    while (/\s/.test(source[i] || '')) i++
    const quote = source[i]
    if (quote !== "'" && quote !== '"' && quote !== '`') return null
    let value = ''
    for (i++; i < source.length; i++) {
        if (source[i] === '\\') {
            if (i + 1 < source.length) value += source[++i]
            continue
        }
        if (source[i] === quote) return value
        value += source[i]
    }
    return null
}

function findCalls (source) {
    const masked = maskNonCode(source)
    const calls = []
    MOCHA_CALL.lastIndex = 0
    let match
    while ((match = MOCHA_CALL.exec(masked)) !== null) {
        const openParen = masked.indexOf('(', match.index)
        const tail = masked.slice(openParen + 1)
        const callback = /(?:async\s+)?(?:function(?:\s+[\w$]+)?\s*\([^)]*\)|\([^)]*\)\s*=>|[\w$]+\s*=>)\s*\{/.exec(tail)
        if (!callback) continue
        const bodyOpen = openParen + 1 + callback.index + callback[0].lastIndexOf('{')
        const bodyClose = closeBrace(masked, bodyOpen)
        calls.push({
            kind: match[1],
            skipped: Boolean(match[2]),
            offset: match.index,
            line: lineAt(source, match.index),
            title: stringAt(source, openParen + 1),
            bodyOpen,
            bodyClose,
        })
    }
    return { calls, masked }
}

function parentSuite (call, calls) {
    return calls
        .filter((candidate) => SUITES.has(candidate.kind) && candidate.bodyOpen < call.offset && candidate.bodyClose > call.offset)
        .sort((a, b) => b.bodyOpen - a.bodyOpen)[0] || null
}

function attachedComment (source, line) {
    const lines = source.split('\n')
    let index = line - 2
    if (index < 0 || /^\s*$/.test(lines[index])) return ''
    const collected = []
    if (/^\s*\/\//.test(lines[index])) {
        while (index >= 0 && /^\s*\/\//.test(lines[index])) collected.unshift(lines[index--])
    } else if (/\*\/\s*$/.test(lines[index])) {
        while (index >= 0) {
            collected.unshift(lines[index])
            if (/\/\*/.test(lines[index--])) break
        }
    } else {
        return ''
    }
    return collected.join(' ')
        .replace(/\/\*+|\*\//g, ' ')
        .replace(/(^|\s)(?:\/\/|\*)\s?/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function reasonFrom (title, comment) {
    const parenthetical = /\(([^()]*(?:driven|needs?|not\s+drivable|because|reason|see\s+comment)[^()]*)\)/i.exec(title || '')
    if (parenthetical) return parenthetical[1].trim()
    if (/\b(?:because|needs?|not\s+drivable|only\s+when|unless|until|driven\s+in)\b/i.test(title || '')) {
        return title.trim()
    }
    return comment && comment.length >= 8 ? comment : ''
}

function availabilityGuard (source, call, offset) {
    const lead = source.slice(Math.max(call.bodyOpen, offset - 600), offset)
    const unavailableVenue = /if\s*\(\s*!\s*up\s*\)/.test(lead) && /unavailable/.test(lead)
    const unavailableRail = /SKIPPED[\s\S]*(?:unreachable|cannot be driven)/.test(lead)
    return unavailableVenue || unavailableRail
}

function parseSource (source, file) {
    const { calls, masked } = findCalls(source)
    const pending = []

    for (const call of calls) {
        if (!TESTS.has(call.kind) || !call.skipped) continue
        const suite = parentSuite(call, calls)
        const title = call.title || '<untitled pending test>'
        const comment = attachedComment(source, call.line)
        pending.push({
            file,
            line: call.line,
            title: suite && suite.title ? suite.title + ' > ' + title : title,
            claim: title,
            comment,
            reason: reasonFrom(title, comment),
            crossrefs: crossrefsFrom(title + ' ' + comment),
            kind: 'declared',
        })
    }

    const skipCall = /\bthis\s*\.\s*skip\s*\(\s*\)/g
    let match
    while ((match = skipCall.exec(masked)) !== null) {
        const containers = calls
            .filter((call) => call.bodyOpen < match.index && call.bodyClose > match.index)
            .sort((a, b) => b.bodyOpen - a.bodyOpen)
        const hook = containers.find((call) => HOOKS.has(call.kind))
        if (!hook || availabilityGuard(source, hook, match.index)) continue
        const suite = parentSuite(hook, calls)
        const suiteTitle = (suite && suite.title) || '<unnamed suite>'
        const title = suiteTitle + ' [' + hook.kind + ' hook]'
        const comment = attachedComment(source, lineAt(source, match.index))
        pending.push({
            file,
            line: lineAt(source, match.index),
            title,
            claim: suiteTitle,
            comment,
            reason: reasonFrom(suiteTitle, comment),
            crossrefs: crossrefsFrom(suiteTitle + ' ' + comment),
            kind: 'hook',
        })
    }

    return { pending: pending.sort((a, b) => a.line - b.line), calls }
}

function crossrefsFrom (text) {
    const found = []
    const matcher = /\b(?:driven|covered)\s+in\s+`?([a-z]+\d+[a-z]?)\b/ig
    let match
    while ((match = matcher.exec(text)) !== null) found.push(match[1].toLowerCase())
    return [...new Set(found)]
}

function walkTests (directory, output) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) walkTests(absolute, output)
        else if (TEST_FILE.test(entry.name)) output.push(absolute)
    }
}

function collectFiles (inputs) {
    const files = []
    const missing = []
    for (const input of inputs) {
        const absolute = path.resolve(input)
        if (!fs.existsSync(absolute)) {
            missing.push(input)
            continue
        }
        const stat = fs.statSync(absolute)
        if (stat.isDirectory()) walkTests(absolute, files)
        else if (stat.isFile()) files.push(absolute)
    }
    return { files: [...new Set(files)].sort(), missing }
}

const STOP_WORDS = new Set([
    'a', 'an', 'and', 'at', 'by', 'comment', 'does', 'driven', 'for', 'in', 'is', 'it', 'leg',
    'names', 'on', 'see', 'specifically', 'test', 'that', 'the', 'this', 'to', 'when', 'with',
])

function claimWords (text) {
    return [...new Set(String(text).toLowerCase().match(/[a-z][a-z0-9_]+/g) || [])]
        .filter((word) => !STOP_WORDS.has(word) && !/^at\d+[a-z]?$/.test(word))
}

function titleMatchesClaim (claim, title) {
    const wanted = claimWords(claim)
    const offered = new Set(claimWords(title))
    if (wanted.some((word) => word.includes('_') && offered.has(word))) return true
    const overlap = wanted.filter((word) => offered.has(word)).length
    return wanted.length > 0 && overlap >= Math.min(2, wanted.length)
}

function resolveCrossrefs (pending, parsedFiles) {
    const checks = []
    for (const item of pending) {
        for (const name of item.crossrefs) {
            const targets = [...parsedFiles.entries()].filter(([file]) => {
                const base = path.basename(file, '.test.js').toLowerCase()
                return base === name || base.startsWith(name + '-') || base.startsWith(name + '_')
            })
            if (!targets.length) {
                checks.push({ item, name, ok: false, why: 'leg file does not exist' })
                continue
            }
            const matching = targets.flatMap(([, parsed]) => parsed.calls)
                .filter((call) => TESTS.has(call.kind) && !call.skipped && call.title)
                .find((call) => {
                    const suite = parentSuite(call, targets.find(([, value]) => value.calls.includes(call))[1].calls)
                    const fullTitle = (suite && suite.title ? suite.title + ' ' : '') + call.title
                    return titleMatchesClaim(item.claim, fullTitle)
                })
            checks.push({
                item,
                name,
                ok: Boolean(matching),
                why: matching ? '' : 'leg has no matching active case title',
            })
        }
    }
    return checks
}

function scanPaths (inputs) {
    const selected = collectFiles(inputs)
    const parsedFiles = new Map()
    const pending = []
    for (const absolute of selected.files) {
        const shown = path.relative(process.cwd(), absolute).split(path.sep).join('/')
        const parsed = parseSource(fs.readFileSync(absolute, 'utf8'), shown)
        parsedFiles.set(absolute, parsed)
        pending.push(...parsed.pending)
    }
    const crossrefs = resolveCrossrefs(pending, parsedFiles)
    return { files: selected.files, missing: selected.missing, pending, crossrefs }
}

function main () {
    const inputs = process.argv.slice(2)
    const result = scanPaths(inputs.length ? inputs : DEFAULT_INPUTS)

    for (const input of result.missing) {
        console.error('mirror-pendings: input path does not exist: ' + input)
    }
    if (result.files.length === 0) {
        console.error('mirror-pendings: read zero files from input')
        return 1
    }

    for (const item of result.pending) {
        console.log('PENDING ' + item.file + ':' + item.line +
            ' | title: ' + item.title +
            ' | reason: ' + (item.reason || '<none>'))
    }

    const unreasoned = result.pending.filter((item) => !item.reason)
    const unresolved = result.crossrefs.filter((check) => !check.ok)
    console.log('mirror-pendings: read ' + result.files.length + ' file(s); found ' + result.pending.length +
        ' pending; cross-references ' + result.crossrefs.length + '; unreasoned ' + unreasoned.length + '.')

    if (result.pending.length === 0) {
        console.error('mirror-pendings: read ' + result.files.length + ' file(s) but found zero pending tests')
    }
    for (const item of unreasoned) {
        console.error('mirror-pendings: unreasoned pending: ' + item.file + ':' + item.line + ' ' + item.title)
    }
    for (const check of unresolved) {
        console.error('mirror-pendings: unresolved cross-reference ' + check.name + ' at ' +
            check.item.file + ':' + check.item.line + ': ' + check.why)
    }

    return result.missing.length || result.pending.length === 0 || unreasoned.length || unresolved.length ? 1 : 0
}

module.exports = {
    collectFiles,
    parseSource,
    scanPaths,
    titleMatchesClaim,
}

if (require.main === module) process.exit(main())
