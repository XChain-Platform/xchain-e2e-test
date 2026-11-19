'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const checker = require('../../../../bin/check-mirror-pendings')

describe('check-mirror-pendings comment-only arguments', () => {
    it('reports a runtime skip whose parentheses contain only a block comment', () => {
        const source = "describe('S', function () { it('case', function () { this.skip(/* later */) }) })"
        const pending = checker.parseSource(source, 'at1.test.js').pending
        assert.strictEqual(pending.length, 1)
        assert.strictEqual(pending[0].kind, 'body')
        assert.strictEqual(pending[0].claim, 'case')
    })

    it('reports a helper skip whose parentheses contain only a line comment', () => {
        const source = ['function pause(mocha) {', '  mocha.skip( // later', '  )', '}'].join('\n')
        const pending = checker.parseSource(source, 'helper.js').pending
        assert.strictEqual(pending.length, 1)
        assert.strictEqual(pending[0].kind, 'helper')
        assert.match(pending[0].title, /pause \[helper skip\]/)
    })

    it('does not mistake literal skip arguments for empty parentheses', () => {
        const source = [
            "reader.skip('header')",
            'reader.skip("header")',
            'reader.skip(`header`)',
            'reader.skip(/header/)',
            'reader.skip(5)',
        ].join('\n')
        assert.deepStrictEqual(checker.parseSource(source, 'reader.js').pending, [])
    })

    it('marks a comment-only trailing test argument as callbackless', () => {
        const parsed = checker.parseSource("describe('S', () => { it('x', /* later */) })", 'at2.test.js')
        assert.deepStrictEqual(parsed.pending.map((item) => item.title), ['S > x'])
        const call = parsed.calls.find((item) => item.kind === 'it' && item.title === 'x')
        assert.ok(call && call.skipped, 'the callbackless case must not count as active')
    })
})
