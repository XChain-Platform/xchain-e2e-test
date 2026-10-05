#!/usr/bin/env node
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SCAN_DIR = path.join(ROOT, 'test', 'attestMirror', 'barrier_family')
const CALL = /\bbootFamilyVenue\s*\(/g
const FRESH_INDEXERS = /\bfreshIndexers\s*:\s*true\b/
const LABEL = /\blabel\s*:\s*(?:'([^'\n]*)'|"([^"\n]*)")/
const OPT_OUT = /\/\/\s*fresh-indexers-ok:\s*\S/

function blankNonCode (source) {
    const chars = source.split('')
    const blank = (from, to) => {
        for (let i = from; i < to; i++) if (chars[i] !== '\n') chars[i] = ' '
    }
    let i = 0
    while (i < source.length) {
        const current = source[i]
        const next = source[i + 1]
        if (current === '/' && next === '/') {
            const end = source.indexOf('\n', i)
            const stop = end === -1 ? source.length : end
            blank(i, stop)
            i = stop
        } else if (current === '/' && next === '*') {
            const end = source.indexOf('*/', i + 2)
            const stop = end === -1 ? source.length : end + 2
            blank(i, stop)
            i = stop
        } else if (current === "'" || current === '"' || current === '`') {
            let end = i + 1
            while (end < source.length && source[end] !== current) {
                end += source[end] === '\\' ? 2 : 1
            }
            blank(i, Math.min(end + 1, source.length))
            i = end + 1
        } else {
            i++
        }
    }
    return chars.join('')
}

function closingParen (source, open) {
    let depth = 0
    for (let i = open; i < source.length; i++) {
        if (source[i] === '(') depth++
        if (source[i] === ')' && --depth === 0) return i
    }
    return -1
}

function hasOptOut (lines, lineIndex) {
    if (OPT_OUT.test(lines[lineIndex] || '')) return true
    for (let i = lineIndex - 1; i >= 0 && /^\s*\/\//.test(lines[i]); i--) {
        if (OPT_OUT.test(lines[i])) return true
    }
    return false
}

function findReusedLabelBoots (source) {
    const code = blankNonCode(source)
    const lines = source.split('\n')
    const findings = []
    let match
    CALL.lastIndex = 0
    while ((match = CALL.exec(code))) {
        const open = code.indexOf('(', match.index)
        const close = closingParen(code, open)
        if (close === -1) continue
        const line = source.slice(0, match.index).split('\n').length
        const call = source.slice(match.index, close + 1)
        if (FRESH_INDEXERS.test(call) || hasOptOut(lines, line - 1)) continue
        const labelMatch = LABEL.exec(call)
        const label = labelMatch && labelMatch[1] !== undefined ? labelMatch[1] : labelMatch?.[2]
        findings.push({ line, label: labelMatch ? label : null })
    }
    return findings
}

function scan () {
    const files = fs.readdirSync(SCAN_DIR)
        .filter((file) => file.endsWith('.test.js'))
        .sort()
    const findings = []
    for (const file of files) {
        const absolute = path.join(SCAN_DIR, file)
        const relative = path.relative(ROOT, absolute).split(path.sep).join('/')
        for (const finding of findReusedLabelBoots(fs.readFileSync(absolute, 'utf8'))) {
            findings.push({ file: relative, ...finding })
        }
    }
    return { files, findings }
}

function main () {
    const { files, findings } = scan()
    for (const finding of findings) {
        console.log(`${finding.file}:${finding.line} label=${finding.label}`)
    }
    console.log(`${findings.length} reused-label boot(s) in ${files.length} file(s)`)
    return findings.length && !process.argv.includes('--report') ? 1 : 0
}

module.exports = { findReusedLabelBoots }

if (require.main === module) process.exit(main())
