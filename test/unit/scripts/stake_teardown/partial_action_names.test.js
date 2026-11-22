'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const gate = require('../../../../bin/check-stake-teardown')

const scan = (source) => gate.scanLines(source.split('\n'), 'test/actions/partial-action.test.js')
const REGISTER = 'stakeTeardown.bookBroadcastStake({ addressInfo, signingPubkey })'

describe('check-stake-teardown partial action names', function () {
    it('resolves constant interpolation in a direct payload', function () {
        const hits = scan('await tx.createAndSendTransaction(addr, `ST${"AKE"}|1|1000|${pk}`)')
        assert.deepStrictEqual(hits.map((hit) => hit.line), [1])
    })

    it('resolves a bound interpolation in a payload binding', function () {
        const hits = scan([
            'const suffix = "AKE"',
            'const msg = `ST${suffix}|1|${pk}`',
            'await tx.createAndSendTransaction(addr, msg)',
        ].join('\n'))
        assert.deepStrictEqual(hits.map((hit) => hit.line), [2])
    })

    it('flags an unresolved partial payload head', function () {
        const hits = scan('await tx.createAndSendTransaction(addr, `ST${verb}|1|${pk}`)')
        assert.deepStrictEqual(hits.map((hit) => hit.line), [1])
    })

    it('resolves interpolated action fields and joined action heads', function () {
        const action = scan('JSON.stringify({ action: `ST${"AKE"}`, params })')
        const joined = scan('const msg = [`ST${"AKE"}`, "1", amount].join("|")')
        assert.deepStrictEqual(action.map((hit) => hit.line), [1])
        assert.deepStrictEqual(joined.map((hit) => hit.line), [1])
    })

    it('does not flag unrelated interpolated values', function () {
        const sources = [
            'await tx.createAndSendTransaction(addr, `UN${"STAKE"}|1|${pk}`)',
            'await tx.createAndSendTransaction(addr, `IS${x}|1`)',
            'await tx.createAndSendTransaction(addr, `SEND|${x}`)',
            'await tx.createAndSendTransaction(addr, `ST${x}Z|1`)',
            'await tx.createAndSendTransaction(addr, `ST${1}AKE|1`)',
            'await tx.createAndSendTransaction(addr, `ST${true}AKE|1`)',
            'await tx.createAndSendTransaction(addr, `ST${false}AKE|1`)',
            'const s = `${tx.action === "STAKE"}`',
        ]
        for (const source of sources) assert.deepStrictEqual(scan(source), [])
    })

    it('honors registration and an opt-out for resolved payloads', function () {
        const payload = 'await tx.createAndSendTransaction(addr, `ST${"AKE"}|1|1000|${pk}`)'
        assert.deepStrictEqual(scan([payload, REGISTER].join('\n')), [])
        assert.deepStrictEqual(scan([
            '// stake-teardown-ok: rejected by the zero amount rule',
            payload,
        ].join('\n')), [])
    })
})
