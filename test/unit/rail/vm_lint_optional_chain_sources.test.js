// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const {
    HIDDEN_SOURCE,
    CONTROL_SOURCE,
    HIDDEN_EXPRESSION
} = require('../../rail/vm_lint/optional_chain_sources')

function differingLineCount(left, right){
    const leftLines = left.split('\n')
    const rightLines = right.split('\n')
    assert.strictEqual(leftLines.length, rightLines.length, 'source line counts should match')
    return leftLines.filter((line, index) => line !== rightLines[index]).length
}

describe('VM optional-chain rail sources', function () {
    it('contains the hidden expression exactly once', function () {
        assert.strictEqual(HIDDEN_SOURCE.split(HIDDEN_EXPRESSION).length - 1, 1)
    })

    it('keeps the optional chain inside parentheses', function () {
        assert.match(HIDDEN_SOURCE, /\([^()\n]*\?\.[^()\n]*\)/)
    })

    it('keeps optional chaining out of the control source', function () {
        assert.strictEqual(CONTROL_SOURCE.includes('?.'), false)
    })

    it('changes exactly one source line for the control', function () {
        assert.strictEqual(differingLineCount(HIDDEN_SOURCE, CONTROL_SOURCE), 1)
    })
})
