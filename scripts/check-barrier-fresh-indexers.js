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
const acorn = require('acorn')
const { optOutMarker } = require('./lib/opt_out_marker')

const ROOT = path.join(__dirname, '..')
const SCAN_DIR = path.join(ROOT, 'test', 'attestMirror', 'barrier_family')
const BOOT = 'bootFamilyVenue'
const isOptOut = optOutMarker('fresh-indexers-ok', { commentText: true })

// Parse the file and keep each line comment by line, so text inside strings never reads as a comment.
function parseWithComments (source) {
    const comments = new Map()
    const ast = acorn.parse(source, {
        ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, locations: true,
        allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true,
        onComment: (block, text, start, end, startLoc) => { if (!block) comments.set(startLoc.line, text) },
    })
    return { ast, comments }
}

function forEachNode (node, visit) {
    if (!node || typeof node.type !== 'string') return
    visit(node)
    for (const key of Object.keys(node)) {
        const child = node[key]
        if (Array.isArray(child)) child.forEach((item) => forEachNode(item, visit))
        else if (child && typeof child.type === 'string') forEachNode(child, visit)
    }
}

// Return the callee name node of a bootFamilyVenue(...) or x.bootFamilyVenue(...) call, else null.
function bootCallee (node) {
    if (node.type !== 'CallExpression') return null
    const callee = node.callee
    if (callee.type === 'Identifier' && callee.name === BOOT) return callee
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.name === BOOT) return callee.property
    return null
}

function objectProperty (object, name) {
    if (!object || object.type !== 'ObjectExpression') return undefined
    const found = object.properties.find((p) => p.type === 'Property' && !p.computed &&
        (p.key.name === name || p.key.value === name))
    return found ? found.value : undefined
}

// Count a boot as fresh only where the helper reads the flag: venue.freshIndexers set to the literal true.
function bootsFresh (call) {
    const flag = objectProperty(objectProperty(call.arguments[0], 'venue'), 'freshIndexers')
    return !!flag && flag.type === 'Literal' && flag.value === true
}

function bootLabel (call) {
    const label = objectProperty(call.arguments[0], 'label')
    return label && label.type === 'Literal' && typeof label.value === 'string' ? label.value : null
}

// Accept a reasoned opt-out comment on the call line or in the comment-only lines directly above it.
function hasOptOut (lines, comments, line) {
    if (isOptOut(comments.get(line))) return true
    for (let k = line - 1; k >= 1 && comments.has(k) && /^\s*\/\//.test(lines[k - 1]); k--) {
        if (isOptOut(comments.get(k))) return true
    }
    return false
}

// Find barrier boots that reuse indexer databases; a file that does not parse is itself a finding.
function findReusedLabelBoots (source) {
    let parsed
    try {
        parsed = parseWithComments(source)
    } catch (error) {
        return [{ line: error.loc ? error.loc.line : 1, label: null, error: 'unparseable: ' + error.message }]
    }
    const lines = source.split('\n')
    const findings = []
    forEachNode(parsed.ast, (node) => {
        const callee = bootCallee(node)
        if (!callee || bootsFresh(node)) return
        const line = callee.loc.start.line
        if (!hasOptOut(lines, parsed.comments, line)) findings.push({ line, label: bootLabel(node), at: callee.start })
    })
    return findings.sort((a, b) => a.at - b.at).map(({ line, label }) => ({ line, label }))
}

function scan (dir = SCAN_DIR) {
    const files = fs.readdirSync(dir)
        .filter((file) => file.endsWith('.test.js'))
        .sort()
    const findings = []
    for (const file of files) {
        const absolute = path.join(dir, file)
        const relative = path.relative(ROOT, absolute).split(path.sep).join('/')
        for (const finding of findReusedLabelBoots(fs.readFileSync(absolute, 'utf8'))) {
            findings.push({ file: relative, ...finding })
        }
    }
    return { files, findings }
}

// A scan that reads no leg file is a broken scan, not a clean corpus, so it fails even under --report.
function main (argv = process.argv.slice(2), dir = SCAN_DIR) {
    const shown = path.relative(ROOT, dir).split(path.sep).join('/') || dir
    let result
    try {
        result = scan(dir)
    } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error
        console.error(`check-barrier-fresh-indexers: scan directory does not exist: ${shown}`)
        return 1
    }
    const { files, findings } = result
    if (files.length === 0) {
        console.error(`check-barrier-fresh-indexers: read zero files from ${shown}`)
        return 1
    }
    for (const finding of findings) {
        console.log(`${finding.file}:${finding.line} label=${finding.label}` + (finding.error ? ` ${finding.error}` : ''))
    }
    console.log(`${findings.length} reused-label boot(s) in ${files.length} file(s)`)
    return findings.length && !argv.includes('--report') ? 1 : 0
}

module.exports = { findReusedLabelBoots, scan, main }

if (require.main === module) process.exit(main())
