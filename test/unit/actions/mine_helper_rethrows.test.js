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
const SWALLOWING_MINE = /async function mine\(n\)[^\n]*\bcatch\b/

function listJs (dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return listJs(full)
        return entry.name.endsWith('.js') ? [full] : []
    })
}

describe('action suite mine() helpers', function () {
    it('flags the swallowing form, so the scan below can fail', function () {
        assert.ok(SWALLOWING_MINE.test('async function mine(n) { try { await x.generateBlocks(n) } catch (e) {} }'))
        assert.ok(!SWALLOWING_MINE.test('async function mine(n) { await x.generateBlocks(n) }'))
    })

    it('finds the suite helpers it is meant to guard', function () {
        const defining = listJs(ACTIONS_DIR).filter((file) => /async function mine\(n\)/.test(fs.readFileSync(file, 'utf8')))
        assert.ok(defining.length >= 9, 'only ' + defining.length + ' suites define mine(n)')
    })

    it('never swallows a generateBlocks failure in an action suite', function () {
        const offenders = listJs(ACTIONS_DIR)
            .filter((file) => SWALLOWING_MINE.test(fs.readFileSync(file, 'utf8')))
            .map((file) => path.relative(ACTIONS_DIR, file))
        assert.deepStrictEqual(offenders, [])
    })
})
