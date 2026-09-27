'use strict'

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
const { custodyWires, DEPOSIT_CASES } = require('../../rail/custody_guard/plan')

describe('custody guard rail plan', function () {
    it('builds the token controller wire field by field', function () {
        const wires = custodyWires({ tick: 'FRESHTICK', controllerIndex: 42 })

        assert.deepStrictEqual(wires.issue.split('|'), [
            'ISSUE', '6', 'FRESHTICK', '42', 'transfer', '0', '0', 'cverify'
        ])
    })

    it('builds the address controller wire field by field', function () {
        const wires = custodyWires({ tick: 'IGNORED', controllerIndex: 42 })

        assert.deepStrictEqual(wires.address.split('|'), [
            'ADDRESS', '1', '42', 'transfer', '0', '0', 'cverify'
        ])
    })

    it('freezes the ordered deposit cases', function () {
        assert(Object.isFrozen(DEPOSIT_CASES))
        assert(DEPOSIT_CASES.every(Object.isFrozen))
        assert.deepStrictEqual(DEPOSIT_CASES, [
            {
                name: 'unbound tick from unbound depositor',
                tokenBound: false,
                depositorBound: false,
                expect: 'valid'
            },
            {
                name: 'token-bound deny guard',
                tokenBound: true,
                depositorBound: false,
                expect: 'invalid'
            },
            {
                name: 'depositor-bound deny guard',
                tokenBound: false,
                depositorBound: true,
                expect: 'invalid'
            }
        ])
    })
})
