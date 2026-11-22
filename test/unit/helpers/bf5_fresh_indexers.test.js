'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 ********************************************************************/

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const acorn = require('acorn')
const { findReusedLabelBoots } = require('../../../bin/check-barrier-fresh-indexers')

const BF5_PATH = path.resolve(__dirname, '..', '..', 'attestMirror', 'barrier_family', 'bf5_flag_day.test.js')

// Count bootFamilyVenue(...) and x.bootFamilyVenue(...) calls in the parsed source, never in comments or strings.
function countBootCalls (source) {
    let count = 0
    const visit = (node) => {
        if (!node || typeof node.type !== 'string') return
        const callee = node.type === 'CallExpression' ? node.callee : null
        if (callee && (callee.name === 'bootFamilyVenue' || (callee.property && callee.property.name === 'bootFamilyVenue'))) count++
        for (const child of Object.values(node)) {
            if (Array.isArray(child)) child.forEach(visit)
            else if (child && typeof child.type === 'string') visit(child)
        }
    }
    visit(acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true }))
    return count
}

describe('BF5 fresh indexers', function () {
    it('passes freshIndexers through the bootFamilyVenue venue options', function () {
        const source = fs.readFileSync(BF5_PATH, 'utf8')

        // Require the boot itself, which the shared lint cannot see go missing, then its fresh-indexer rule.
        assert.ok(countBootCalls(source) >= 1, 'BF5 must boot its venue through bootFamilyVenue')
        assert.deepStrictEqual(findReusedLabelBoots(source), [])
    })
})
