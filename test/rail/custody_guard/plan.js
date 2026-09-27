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

function custodyWires({ tick, controllerIndex }) {
    return {
        issue: ['ISSUE', '6', tick, controllerIndex, 'transfer', '0', '0', 'cverify'].join('|'),
        address: ['ADDRESS', '1', controllerIndex, 'transfer', '0', '0', 'cverify'].join('|')
    }
}

const DEPOSIT_CASES = Object.freeze([
    Object.freeze({
        name: 'unbound tick from unbound depositor',
        tokenBound: false,
        depositorBound: false,
        expect: 'valid'
    }),
    Object.freeze({
        name: 'token-bound deny guard',
        tokenBound: true,
        depositorBound: false,
        expect: 'invalid'
    }),
    Object.freeze({
        name: 'depositor-bound deny guard',
        tokenBound: false,
        depositorBound: true,
        expect: 'invalid'
    })
])

module.exports = { custodyWires, DEPOSIT_CASES }
