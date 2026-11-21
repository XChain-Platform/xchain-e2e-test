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

// A suite-local mine() that swallows its failure drops the miner's refusal
// (RegtestMinerConnector.unwrap throws it), so a refused mine surfaces much
// later as an unrelated assertion. Every action suite's mine() must rethrow.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ACTIONS_DIR = path.resolve(__dirname, '../../actions')
const SDK_MINE_HELPER = path.resolve(__dirname, '../../sdk/helpers/mine.js')
const SDK_HELPER = path.resolve(__dirname, '../../sdk/helpers/sdkHelper.js')

function mineBody(source) {
    const declaration = /async function mine\s*\([^)]*\)\s*\{/.exec(source)
    if (!declaration) return null
    let depth = 1
    for (let index = declaration.index + declaration[0].length; index < source.length; index++) {
        if (source[index] === '{') depth += 1
        if (source[index] === '}') depth -= 1
        if (depth === 0) return source.slice(declaration.index, index + 1)
    }
    return null
}

function swallowingMine(source) {
    const body = mineBody(source)
    if (!body || !/\bgenerateBlocks\s*\(/.test(body)) return false
    return Array.from(body.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/g))
        .some((match) => !/\bthrow\b/.test(match[1]))
}

function listJs (dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return listJs(full)
        return entry.name.endsWith('.js') ? [full] : []
    })
}

describe('action suite mine() helpers', function () {
    it('flags the swallowing form, so the scan below can fail', function () {
        assert.ok(swallowingMine('async function mine(n) { try { await x.generateBlocks(n) } catch (e) {} }'))
        assert.ok(swallowingMine('async function mine(blocks = 1) {\ntry { await x.generateBlocks(blocks) }\ncatch (e) {}\n}'))
        assert.ok(!swallowingMine('async function mine(n) { await x.generateBlocks(n) }'))
        assert.ok(!swallowingMine('async function mine(n) { try { await x.generateBlocks(n) } catch (e) { throw e } }'))
    })

    it('finds the suite helpers it is meant to guard', function () {
        const defining = listJs(ACTIONS_DIR).filter((file) => /async function mine\(n\)/.test(fs.readFileSync(file, 'utf8')))
        assert.ok(defining.length >= 9, 'only ' + defining.length + ' suites define mine(n)')
    })

    it('never swallows a generateBlocks failure in an action suite', function () {
        const offenders = listJs(ACTIONS_DIR)
            .filter((file) => swallowingMine(fs.readFileSync(file, 'utf8')))
            .map((file) => path.relative(ACTIONS_DIR, file))
        assert.deepStrictEqual(offenders, [])
    })

    it('guards the SDK mine helper without matching unrelated functions', function () {
        const mineSource = fs.readFileSync(SDK_MINE_HELPER, 'utf8')
        const sdkSource = fs.readFileSync(SDK_HELPER, 'utf8')
        assert.ok(mineBody(mineSource), 'SDK mine helper is missing')
        assert.strictEqual(swallowingMine(mineSource), false)
        assert.match(sdkSource, /require\(['"]\.\/mine['"]\)/)
        assert.doesNotMatch(sdkSource, /async function mine\s*\(/)
    })
})
