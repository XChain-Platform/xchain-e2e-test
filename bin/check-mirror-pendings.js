#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')
const { MIN_REASON_WORDS, reasonWords } = require('./lib/opt_out_marker')

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_INPUTS = [path.join(ROOT, 'test', 'attestMirror')]
const TEST_FILE = /\.test\.js$/
// Read helper modules too: a skip a hook hands to a helper lives there, not in the leg file.
const SOURCE_FILE = /\.js$/
// Match the x-prefixed skip aliases too; the lookbehind keeps a member call such as re.test( out.
const MOCHA_CALL = /(?<![.$\w])(x?(?:describe|context|it|specify)|suite|test|before|beforeEach|setup)(\.skip)?\s*\(/g
const BASE_KIND = { specify: 'it', xspecify: 'it', xit: 'it', xdescribe: 'describe', xcontext: 'context' }
const HOOKS = new Set(['before', 'beforeEach', 'setup'])
const SUITES = new Set(['describe', 'context', 'suite'])
const TESTS = new Set(['it', 'test'])
// Every name MOCHA_CALL declares with, so `<name>.skip(` is read as a declaration, never a runtime skip.
const MOCHA_DECLARERS = new Set(['describe', 'context', 'it', 'specify', 'xdescribe', 'xcontext', 'xit', 'xspecify',
    'suite', 'test', 'before', 'beforeEach', 'setup'])

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

function closeParen (masked, open) {
    let depth = 0
    for (let i = open; i < masked.length; i++) {
        if (masked[i] === '(') depth++
        else if (masked[i] === ')') {
            depth--
            if (depth === 0) return i
        }
    }
    return masked.length
}

// Split the masked text between from and to at top-level commas; a trailing empty argument is dropped.
function topLevelArgs (masked, source, from, to) {
    const args = []
    let depth = 0
    let start = from
    for (let i = from; i < to; i++) {
        const c = masked[i]
        if (c === '(' || c === '[' || c === '{') depth++
        else if (c === ')' || c === ']' || c === '}') depth--
        else if (c === ',' && depth === 0) {
            args.push({ start, end: i })
            start = i + 1
        }
    }
    args.push({ start, end: to })
    // Judge emptiness on the source: masking blanks a string argument to whitespace.
    return args.filter((arg, index) => index === 0 || index < args.length - 1 || source.slice(arg.start, arg.end).trim() !== '')
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
        const parenClose = closeParen(masked, openParen)
        const args = topLevelArgs(masked, source, openParen + 1, parenClose)
        const last = args[args.length - 1]
        // Look for the callback only at the head of the call's own last argument.
        const callback = last && /^\s*(?:async\s+)?(?:function(?:\s+[\w$]+)?\s*\([^)]*\)|\([^)]*\)\s*=>|[\w$]+\s*=>)\s*\{/
            .exec(masked.slice(last.start, last.end))
        // Without a block body (expression arrow, named function, no callback), the call spans its own parentheses.
        const bodyOpen = callback ? last.start + callback[0].lastIndexOf('{') : openParen
        const bodyClose = callback ? closeBrace(masked, bodyOpen) : parenClose
        const kind = BASE_KIND[match[1]] || match[1]
        // Mocha treats a test declared with a title and no callback as pending.
        const callbackless = TESTS.has(kind) && args.length === 1
        calls.push({
            kind,
            skipped: Boolean(match[2]) || match[1].startsWith('x') || callbackless,
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

// Take a reason only from a keyword parenthetical in the title or an attached comment, never the bare title.
function reasonFrom (title, comment) {
    const parenthetical = /\(([^()]*(?:driven|needs?|not\s+drivable|because|reason|see\s+comment)[^()]*)\)/i.exec(title || '')
    // Hold both sources to the reason rule every check-* gate shares, not a length floor.
    if (parenthetical && reasonWords(parenthetical[1]) >= MIN_REASON_WORDS) return parenthetical[1].trim()
    return comment && reasonWords(comment) >= MIN_REASON_WORDS ? comment : ''
}

// Find the innermost block still open at offset inside the call body, or -1 for the body itself.
function enclosingBlockOpen (masked, from, offset) {
    let depth = 0
    for (let i = offset - 1; i > from; i--) {
        if (masked[i] === '}') depth++
        else if (masked[i] === '{') {
            if (depth === 0) return i
            depth--
        }
    }
    return -1
}

// Return the source and code arguments of a console.log that is the statement right before offset, or null.
function previousLogArgs (source, masked, blockStart, offset) {
    // A `return` in front of the skip belongs to the skip's own statement.
    const before = masked.slice(blockStart, offset).replace(/\breturn\s*$/, '').replace(/[\s;]+$/, '')
    if (!before.endsWith(')')) return null
    const close = blockStart + before.length - 1
    let depth = 0
    let open = close
    for (; open >= blockStart; open--) {
        if (masked[open] === ')') depth++
        else if (masked[open] === '(' && --depth === 0) break
    }
    if (open < blockStart || !/console\s*\.\s*log\s*$/.test(masked.slice(blockStart, open))) return null
    return { text: source.slice(open + 1, close), code: masked.slice(open + 1, close) }
}

// Exempt only the venue-down skip itself, judged on code rather than comments: a statement of an
// `if (!up) { ... }` block that reads `.unavailable`, or the statement right after a SKIPPED log
// that says unreachable or cannot-be-driven, or that reads the venue's `.unavailable` in code.
// A skip that merely sits near such text is still reported. bodyOpen is -1 for a helper skip.
function availabilityGuard (source, masked, bodyOpen, offset) {
    const open = enclosingBlockOpen(masked, bodyOpen, offset)
    const blockStart = open === -1 ? bodyOpen + 1 : open + 1
    const head = open === -1 ? '' : masked.slice(bodyOpen + 1, open)
    const unavailableVenue = /\bif\s*\(\s*!\s*up\s*\)\s*$/.test(head) &&
        /\.\s*unavailable\b/.test(masked.slice(blockStart, offset))
    const log = previousLogArgs(source, masked, blockStart, offset)
    const unavailableRail = log !== null && (/SKIPPED[\s\S]*(?:unreachable|cannot be driven)/.test(log.text) ||
        (/SKIPPED/.test(log.text) && /\.\s*unavailable\b/.test(log.code)))
    return unavailableVenue || unavailableRail
}

// Name the function whose body holds offset, for a skip outside any hook or test body.
function enclosingFunctionName (masked, offset) {
    const head = /(?:\bfunction\b\s*([\w$]*)\s*\([^()]*\)|(?:([\w$]+)\s*[=:]\s*)?(?:async\s+)?(?:\([^()]*\)|[\w$]+)\s*=>|\b(?!(?:if|for|while|switch|catch|with)\b)([\w$]+)\s*\([^()]*\))\s*$/
    let open = enclosingBlockOpen(masked, -1, offset)
    while (open !== -1) {
        const found = head.exec(masked.slice(Math.max(0, open - 300), open))
        if (found) return found[1] || found[2] || found[3] || 'anonymous function'
        open = enclosingBlockOpen(masked, -1, open)
    }
    return 'top level'
}

function pendingEntry (file, line, title, claim, comment, kind) {
    return {
        file,
        line,
        title,
        claim,
        comment,
        reason: reasonFrom(claim, comment),
        crossrefs: crossrefsFrom(claim + ' ' + comment),
        kind,
    }
}

function underSuite (suite, title) {
    return suite && suite.title ? suite.title + ' > ' + title : title
}

// Report each skipped test, and each skipped suite with the count of cases it hides.
function declaredPendings (source, file, calls) {
    const pending = []
    for (const call of calls) {
        if (!call.skipped) continue
        const suite = parentSuite(call, calls)
        const comment = attachedComment(source, call.line)
        if (TESTS.has(call.kind)) {
            const title = call.title || '<untitled pending test>'
            pending.push(pendingEntry(file, call.line, underSuite(suite, title), title, comment, 'declared'))
        } else if (SUITES.has(call.kind)) {
            const title = call.title || '<untitled skipped suite>'
            const hidden = calls.filter((c) => TESTS.has(c.kind) && c.offset > call.bodyOpen && c.offset < call.bodyClose)
            const shown = underSuite(suite, title) + ' [skipped suite, ' + hidden.length + ' cases]'
            pending.push(pendingEntry(file, call.line, shown, title, comment, 'suite'))
        }
    }
    return pending
}

// Report a runtime skip, except the standard unavailable-venue guard: this.skip(), or the mocha
// context a hook passes into a helper (mocha.skip()). A skip outside any hook or test body is
// charged to its helper function, since the gate cannot follow the call back to a test.
function runtimePendings (source, file, calls, masked) {
    const pending = []
    const skipCall = /(?<![.$\w])([A-Za-z_$][\w$]*)\s*\.\s*skip\s*\(/g
    let match
    while ((match = skipCall.exec(masked)) !== null) {
        const openParen = match.index + match[0].length - 1
        // A declared skip (it.skip, describe.skip) or a skip with arguments is not mocha's runtime skip.
        if (MOCHA_DECLARERS.has(match[1]) || source.slice(openParen + 1, closeParen(masked, openParen)).trim() !== '') continue
        const container = calls
            .filter((call) => call.bodyOpen < match.index && call.bodyClose > match.index)
            .sort((a, b) => b.bodyOpen - a.bodyOpen)
            .find((call) => HOOKS.has(call.kind) || TESTS.has(call.kind))
        if (container && container.skipped) continue
        if (availabilityGuard(source, masked, container ? container.bodyOpen : -1, match.index)) continue
        const line = lineAt(source, match.index)
        const comment = attachedComment(source, line)
        if (!container) {
            const title = enclosingFunctionName(masked, match.index) + ' [helper skip]'
            pending.push(pendingEntry(file, line, title, title, comment, 'helper'))
            continue
        }
        const suite = parentSuite(container, calls)
        if (TESTS.has(container.kind)) {
            const title = container.title || '<untitled test>'
            pending.push(pendingEntry(file, line, underSuite(suite, title), title, comment, 'body'))
            continue
        }
        const suiteTitle = (suite && suite.title) || '<unnamed suite>'
        pending.push(pendingEntry(file, line, suiteTitle + ' [' + container.kind + ' hook]', suiteTitle, comment, 'hook'))
    }
    return pending
}

function parseSource (source, file) {
    const { calls, masked } = findCalls(source)
    const pending = declaredPendings(source, file, calls).concat(runtimePendings(source, file, calls, masked))
    return { pending: pending.sort((a, b) => a.line - b.line), calls }
}

// Gather each named leg with every case title quoted right after it ('DRIVEN in at2b: "<title>"').
function crossrefsFrom (text) {
    const legs = new Map()
    const matcher = /\b(?:driven|covered)\s+in\s+`?([a-z]+\d+[a-z]?)\b`?(?:\s*[:,]?\s*(["'`])(.+?)\2)?/ig
    let match
    while ((match = matcher.exec(text)) !== null) {
        const name = match[1].toLowerCase()
        if (!legs.has(name)) legs.set(name, { name, anchors: [] })
        if (match[3]) legs.get(name).anchors.push(match[3])
    }
    return [...legs.values()]
}

function walkTests (directory, output) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) walkTests(absolute, output)
        else if (SOURCE_FILE.test(entry.name)) output.push(absolute)
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

function normalizeTitle (text) {
    return String(text).toLowerCase().replace(/\s+/g, ' ').trim()
}

// Compare a quoted anchor with a case's OWN title (a suite title would vouch for every case under it).
function titleMatchesClaim (anchor, caseTitle) {
    return normalizeTitle(anchor) !== '' && normalizeTitle(anchor) === normalizeTitle(caseTitle)
}

// Collect the titles of cases that run: not skipped and under no skipped suite.
function activeCaseTitles (calls) {
    const suites = calls.filter((call) => SUITES.has(call.kind) && call.skipped)
    return calls
        .filter((call) => TESTS.has(call.kind) && !call.skipped && call.title)
        .filter((call) => !suites.some((suite) => suite.bodyOpen < call.offset && suite.bodyClose > call.offset))
        .map((call) => call.title)
}

function legFiles (parsedFiles, name) {
    return [...parsedFiles.entries()].filter(([file]) => {
        // Only a leg file can be a cross-reference target; a helper module named zc1_fixture.js is not leg zc1.
        if (!TEST_FILE.test(file)) return false
        const base = path.basename(file, '.test.js').toLowerCase()
        return base === name || base.startsWith(name + '-') || base.startsWith(name + '_')
    })
}

function checkCrossref (item, ref, parsedFiles) {
    const targets = legFiles(parsedFiles, ref.name)
    const fail = (why) => ({ item, name: ref.name, ok: false, why })
    if (!targets.length) return fail('leg file does not exist')
    if (!ref.anchors.length) {
        return fail('leg has no matching active case title: the reference quotes no target case; ' +
            'quote the active case title after the leg name')
    }
    const titles = targets.flatMap(([, parsed]) => activeCaseTitles(parsed.calls))
    const missing = ref.anchors.find((anchor) => !titles.some((title) => titleMatchesClaim(anchor, title)))
    if (missing !== undefined) return fail('leg has no matching active case title: no active case titled "' + missing + '"')
    return { item, name: ref.name, ok: true, why: '' }
}

function resolveCrossrefs (pending, parsedFiles) {
    return pending.flatMap((item) => item.crossrefs.map((ref) => checkCrossref(item, ref, parsedFiles)))
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
