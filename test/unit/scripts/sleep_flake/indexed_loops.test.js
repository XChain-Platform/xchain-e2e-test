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
const scanner = require('../../../../bin/check-sleep-flake')

const linesOf = (source) => scanner.scanSource(source, 'fixture.js').hits.map((hit) => hit.line)

describe('check-sleep-flake indexed loops', function () {
    it('counts a settle in an indexed data loop', function () {
        const source = [
            'async function t() {',
            '    for (let i = 0; i < cases.length; i++) {',
            '        await send(cases[i])',
            '        await sleep(5000)',
            '    }',
            '}',
        ].join('\n')

        assert.deepStrictEqual(linesOf(source), [4])
    })

    it('counts brace-less and inline indexed settles', function () {
        const braceLess = 'async function t() {\nfor (let i = 0; i < 3; i++) await sleep(1000)\n}'
        const inline = [
            'async function t() {',
            '    for (let k = 0; k < 3; k++) {',
            '        await new Promise((resolve) => setTimeout(resolve, 20000))',
            '    }',
            '}',
        ].join('\n')

        assert.deepStrictEqual(linesOf(braceLess), [2])
        assert.deepStrictEqual(linesOf(inline), [3])
    })

    it('keeps loops with a live condition or early exit exempt', function () {
        const liveTest = [
            'async function t() {',
            '    for (let i = 0; i < 20 && !(await ok()); i++) await sleep(500)',
            '}',
        ].join('\n')
        const earlyExit = [
            'async function t() {',
            '    for (let i = 0; i < 20; i++) {',
            '        if (await ok()) break',
            '        await sleep(500)',
            '    }',
            '}',
        ].join('\n')
        const liveUpdate = [
            'async function t() {',
            '    for (let i = 0; i < 20; i = await nextIndex()) await sleep(500)',
            '}',
        ].join('\n')

        assert.deepStrictEqual(linesOf(liveTest), [])
        assert.deepStrictEqual(linesOf(earlyExit), [])
        assert.deepStrictEqual(linesOf(liveUpdate), [])
    })

    it('does not change while-loop classification', function () {
        const source = 'async function t() {\nwhile (received < 3) await sleep(100)\n}'

        assert.deepStrictEqual(linesOf(source), [])
    })
})

// A loop whose body holds `inner` before a 5s settle on line 4.
const shape = (inner, head = 'for (let i = 0; i < cases.length; i++)') => [
    'async function t() {',
    `    ${head} {`,
    `        ${inner}`,
    '        await sleep(5000)',
    '    }',
    '}',
].join('\n')

describe('check-sleep-flake loop body exits', function () {
    it('counts a settle whose loop exits only from nested callbacks, loops or switches', function () {
        assert.deepStrictEqual(linesOf(shape('const ok = cases.map((c) => { return c.ok })')), [4])
        assert.deepStrictEqual(linesOf(shape('rows.forEach(function (r) { if (r) throw r })')), [4])
        assert.deepStrictEqual(linesOf(shape('for (const r of rows) { if (r) break }')), [4])
        assert.deepStrictEqual(linesOf(shape('for (const r of rows) if (r) break')), [4])
        assert.deepStrictEqual(linesOf(shape('switch (k) { case 1: go(); break }')), [4])
        assert.deepStrictEqual(linesOf(shape('iter.return()')), [4])
        assert.deepStrictEqual(linesOf(shape('inner: for (const r of rows) { for (const q of r) { if (q) break inner } }')), [4])
        assert.deepStrictEqual(linesOf(shape('rows.forEach((r) => { return r })', 'while (true)')), [4])
    })

    it('counts a settle whose loop only continues or throws into its own catch', function () {
        const continued = shape('for (const r of rows) { if (r) continue outer }', 'outer: for (let i = 0; i < n; i++)')
        const caught = shape('try { if (await bad()) throw new Error("x") } catch (e) { log(e) }')

        assert.deepStrictEqual(linesOf(continued), [4])
        assert.deepStrictEqual(linesOf(caught), [4])
    })

    it('keeps a loop exempt when its own body exits through a block or label', function () {
        assert.deepStrictEqual(linesOf(shape('if (await ok()) { return }')), [])
        assert.deepStrictEqual(linesOf(shape('try { if (await bad()) throw new Error("x") } finally { log() }')), [])
        assert.deepStrictEqual(linesOf(shape('try { await step() } catch (e) { throw e }')), [])
        assert.deepStrictEqual(linesOf(shape('for (const r of rows) { if (r) break outer }', 'outer: for (let i = 0; i < n; i++)')), [])
        assert.deepStrictEqual(linesOf(shape('if (await ok()) return', 'while (true)')), [])
    })
})
