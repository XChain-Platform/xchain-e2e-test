'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const checker = require('../../../../bin/check-mirror-pendings')

describe('check-mirror-pendings runtime skip arguments', function () {
    it('reports this.skip with an ignored argument', function () {
        const source = "describe('S', function () { it('case', function () { this.skip('ignored') }) })"
        const pending = checker.parseSource(source, 'at1.test.js').pending
        assert.deepStrictEqual(pending.map((item) => [item.kind, item.claim]), [['body', 'case']])
    })

    it('reports a helper mocha.skip with an ignored argument', function () {
        const source = 'function settle (ctx, mocha) { mocha.skip(ctx.reason) }'
        const pending = checker.parseSource(source, 'helper.js').pending
        assert.deepStrictEqual(pending.map((item) => [item.kind, item.title]),
            [['helper', 'settle [helper skip]']])
    })

    it('reports context chains without reclassifying them as declarations', function () {
        const source = "describe('S', function () { it('case', function () { this.test.skip() }) })"
        const parsed = checker.parseSource(source, 'at1.test.js')
        assert.deepStrictEqual(parsed.pending.map((item) => [item.kind, item.claim]), [['body', 'case']])
        assert.strictEqual(parsed.calls.filter((call) => call.kind === 'test').length, 0)
    })

    it('keeps argument-carrying calls on unrelated receivers unreported', function () {
        const source = "function readRows (path) { const reader = open(path); reader.skip('header') }"
        assert.deepStrictEqual(checker.parseSource(source, 'reader.js').pending, [])
    })
})
