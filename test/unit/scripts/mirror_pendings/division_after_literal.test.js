'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const checker = require('../../../../bin/check-mirror-pendings')

function pendingFor (statement) {
    const source = "describe('S', function () { it('claim', function () { " + statement +
        "; this.skip(); /x/.test('x'); }) })"
    return checker.parseSource(source, 'at1.test.js').pending
}

describe('check-mirror-pendings division after literals', function () {
    for (const [name, statement] of [
        ['single-quoted string', "const n = '12' / 2"],
        ['double-quoted string', 'const n = "12" / 2'],
        ['plain template', 'const n = `12` / 2'],
        ['interpolated template', 'const a = 12; const n = `${a}` / 2'],
    ]) {
        it('keeps a runtime skip visible after a ' + name, function () {
            const pending = pendingFor(statement)
            assert.deepStrictEqual(pending.map((item) => [item.kind, item.claim]), [['body', 'claim']])
        })
    }

    it('continues to mask skip text inside non-code spans', function () {
        const sources = [
            "describe('S', function () { it('claim', function () { const r = /this.skip()/ }) })",
            "describe('S', function () { it('claim', function () { const r = /* c */ /this.skip()/ }) })",
            "describe('S', function () { it('claim', function () { const s = 'this.skip()' }) })",
        ]
        for (const source of sources) {
            assert.deepStrictEqual(checker.parseSource(source, 'at1.test.js').pending, [])
        }
    })
})
