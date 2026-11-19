'use strict'

const { templateLiteralEnd } = require('./template_literal')

const REGEX_AFTER_KEYWORDS = new Set([
    'return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await',
    'void', 'delete', 'new', 'instanceof', 'throw',
])

function slashStartsRegex (previous) {
    if (!previous) return true
    if (previous.type === 'identifier') return REGEX_AFTER_KEYWORDS.has(previous.value)
    if (previous.type !== 'punctuator') return false
    return !/^(?:[)\]0-9]|\+\+|--)$/.test(previous.value)
}

function regexEnd (source, start) {
    let i = start + 1
    let inClass = false
    while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === '[') inClass = true
        else if (source[i] === ']') inClass = false
        else if (source[i] === '/' && !inClass) {
            i++
            while (/[a-z]/i.test(source[i] || '')) i++
            return i
        }
        i++
    }
    return -1
}

function quotedEnd (source, start) {
    const quote = source[start]
    let i = start + 1
    while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') i += 2
        else if (source[i] === quote) return i + 1
        else i++
    }
    return i
}

function nextToken (source, start) {
    const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(start))
    if (identifier) return { type: 'identifier', value: identifier[0], end: start + identifier[0].length }
    const operator = /^(?:===|!==|=>|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\+=|-=|\*\*|\?\.)/.exec(source.slice(start))
    const value = operator ? operator[0] : source[start]
    return { type: 'punctuator', value, end: start + value.length }
}

function lineComments (source) {
    const comments = new Map()
    let i = 0
    let line = 1
    let previous = null
    while (i < source.length) {
        if (source[i] === '\n') { line++; i++; continue }
        if (/\s/.test(source[i])) { i++; continue }
        if (source.startsWith('//', i)) {
            const end = source.indexOf('\n', i + 2)
            const stop = end === -1 ? source.length : end
            comments.set(line, source.slice(i + 2, stop))
            i = stop
            continue
        }
        if (source.startsWith('/*', i)) {
            const end = source.indexOf('*/', i + 2)
            const stop = end === -1 ? source.length : end + 2
            line += (source.slice(i, stop).match(/\n/g) || []).length
            i = stop
            continue
        }
        if (source[i] === '"' || source[i] === "'") {
            i = quotedEnd(source, i); previous = { type: 'string', value: '' }; continue
        }
        if (source[i] === '`') {
            const stop = templateLiteralEnd(source, i)
            line += (source.slice(i, stop).match(/\n/g) || []).length
            i = stop; previous = { type: 'template', value: '' }; continue
        }
        if (source[i] === '/' && slashStartsRegex(previous)) {
            const stop = regexEnd(source, i)
            if (stop !== -1) { i = stop; previous = { type: 'regex', value: '' }; continue }
        }
        previous = nextToken(source, i)
        i = previous.end
    }
    return comments
}

function markerFor (lines, comments, line, isMarker) {
    if (isMarker(comments.get(line))) return (lines[line - 1] || '').trim()
    for (let current = line - 1; current >= 1 && comments.has(current) &&
        /^\s*\/\//.test(lines[current - 1]); current--) {
        if (isMarker(comments.get(current))) return lines[current - 1].trim()
    }
    return null
}

module.exports = { lineComments, markerFor, regexEnd, slashStartsRegex }
