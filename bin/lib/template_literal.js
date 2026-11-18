'use strict'

// Finds where a template literal ends without a parser, so the gates can still
// run before npm install. Inside `${ }` a slash either opens a regex or divides,
// and a wrong guess moves every later boundary. The token before the slash
// settles most cases. When it cannot (a closing brace, `for await (...)`, `of`,
// `yield`, `await`), the slash is division only if nothing on the rest of its
// line could close a regex; otherwise the scan throws AMBIGUOUS_TEMPLATE, so a
// gate fails loudly instead of reading the wrong text as code.

const AMBIGUOUS_TEMPLATE = 'AMBIGUOUS_TEMPLATE'
const LINE_END = /[\n\r\u2028\u2029]/
const IDENTIFIER = /(?:[\p{ID_Start}$_]|\\u[\da-fA-F]{4}|\\u\{[\da-fA-F]+\})(?:[\p{ID_Continue}$\u200c\u200d]|\\u[\da-fA-F]{4}|\\u\{[\da-fA-F]+\})*/uy
const NUMBER = /(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y
const OPERATOR = /\.\.\.|\?\.(?!\d)|\+\+|--/y
const UNSETTLED_WORDS = new Set(['of', 'yield', 'await'])
const CONTROL_WORDS = new Set(['if', 'while', 'for', 'with'])
const KEYWORDS = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
    'else', 'enum', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in',
    'instanceof', 'new', 'return', 'switch', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with',
])

function fail (source, index, what) {
    const line = source.slice(0, index).split(/\r\n?|[\n\u2028\u2029]/).length
    const error = new Error('cannot tell ' + what + ' inside a template interpolation at line ' + line +
        '; move that expression out of the template')
    error.code = AMBIGUOUS_TEMPLATE
    throw error
}

function stickyMatch (pattern, source, index) {
    pattern.lastIndex = index
    const match = pattern.exec(source)
    return match ? match[0] : null
}

function quotedEnd (source, start) {
    const quote = source[start]
    let i = start + 1
    while (i < source.length) {
        if (source[i] === '\\') i += 2
        else if (source[i] === quote) return i + 1
        else i++
    }
    return source.length
}

// A regex literal cannot span lines, so -1 means this slash cannot open one.
function regexEnd (source, start) {
    let i = start + 1
    let inClass = false
    while (i < source.length && !LINE_END.test(source[i])) {
        if (source[i] === '\\') i += 2
        else if (source[i] === '[') { inClass = true; i++ }
        else if (source[i] === ']') { inClass = false; i++ }
        else if (source[i] === '/' && !inClass) {
            i++
            while (/[a-z]/i.test(source[i] || '')) i++
            return i
        } else i++
    }
    return -1
}

function slashOpensRegex (source, i, after) {
    if (after !== 'unsettled') return after === 'regex'
    if (regexEnd(source, i) !== -1) fail(source, i, 'a regex from a division')
    return false
}

function commentEnd (source, start, state) {
    let i = start + 2
    if (source[start + 1] === '/') {
        while (i < source.length && !LINE_END.test(source[i])) i++
        return i
    }
    const end = source.indexOf('*/', i)
    const stop = end === -1 ? source.length : end + 2
    if (LINE_END.test(source.slice(start, stop))) state.newline = true
    return stop
}

function wordMeaning (name) {
    if (UNSETTLED_WORDS.has(name)) return 'unsettled'
    return KEYWORDS.has(name) ? 'regex' : 'division'
}

function punctuatorMeaning (op, word, state) {
    if (op === '(') {
        state.parens.push(CONTROL_WORDS.has(word) ? 'regex' : word === 'await' ? 'unsettled' : 'division')
        return 'regex'
    }
    if (op === ')') return state.parens.pop() || 'division'
    if (op === ']') return 'division'
    if (op === '{') { state.braces++; return 'regex' }
    if (op === '}') { state.braces--; return 'unsettled' }
    // A line break before ++ or -- makes it prefix; otherwise the token before decides.
    if (op === '++' || op === '--') return state.newline ? 'regex' : state.after
    return 'regex'
}

// Consumes one token at i and records what a slash right after it would mean.
function tokenEnd (source, i, state) {
    const c = source[i]
    const { property, word } = state
    state.property = false
    state.word = null
    if (c === "'" || c === '"') { state.after = 'division'; return quotedEnd(source, i) }
    if (c === '`') { state.after = 'division'; return templateLiteralEnd(source, i) }
    if (c === '/' && slashOpensRegex(source, i, state.after)) {
        const end = regexEnd(source, i)
        if (end !== -1) { state.after = 'division'; return end }
    }
    const name = stickyMatch(IDENTIFIER, source, i)
    if (name) {
        if (!property) state.word = name
        state.after = property ? 'division' : wordMeaning(name)
        return i + name.length
    }
    const number = stickyMatch(NUMBER, source, i)
    if (number) { state.after = 'division'; return i + number.length }
    if (source.startsWith('<!--', i) || (state.newline && source.startsWith('-->', i))) {
        fail(source, i, 'an HTML-like comment from an operator')
    }
    const op = stickyMatch(OPERATOR, source, i) || c
    state.after = punctuatorMeaning(op, word, state)
    state.property = op === '.' || op === '?.' || op === '#'
    return i + op.length
}

// start is the first character after `${`; returns the index just past its `}`.
function interpolationEnd (source, start) {
    const state = { after: 'regex', braces: 0, parens: [], word: null, property: false, newline: false }
    let i = start
    while (i < source.length) {
        const c = source[i]
        if (LINE_END.test(c)) { state.newline = true; i++; continue }
        if (/\s/.test(c)) { i++; continue }
        if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
            i = commentEnd(source, i, state)
            continue
        }
        if (c === '}' && state.braces === 0) return i + 1
        i = tokenEnd(source, i, state)
        state.newline = false
    }
    return source.length
}

// start is an opening backtick; returns the index just past its closing one.
function templateLiteralEnd (source, start) {
    let i = start + 1
    while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === '`') return i + 1
        if (source[i] === '$' && source[i + 1] === '{') {
            i = interpolationEnd(source, i + 2)
            continue
        }
        i++
    }
    return source.length
}

// Runs one file's scan and prefixes an ambiguity error with the file it came from.
function scanNamed (file, scan) {
    try {
        return scan()
    } catch (error) {
        if (error.code === AMBIGUOUS_TEMPLATE) error.message = file + ': ' + error.message
        throw error
    }
}

module.exports = { AMBIGUOUS_TEMPLATE, interpolationEnd, scanNamed, templateLiteralEnd }
