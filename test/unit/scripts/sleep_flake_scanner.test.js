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

// The fixed-settle ratchet read one spelling of a wait, `await sleep(n)`, and
// was blind to the inline one, `await new Promise(r => setTimeout(r, n))`,
// which is the commoner form in this tree. A gate that cannot see the shape
// people actually write does not gate. Widening the detector is easy to get
// wrong in both directions, so both directions are pinned here:
//
//  - UNDER-COUNTING is what the widening exists to fix, and the helper form
//    must keep counting exactly as it did (the baseline was written from it).
//  - OVER-COUNTING would inflate the baseline with things that are not waits
//    on a duration at all: `sleep` helper DEFINITIONS, `Promise.race` timeout
//    arms, and event waits that resolve on a condition rather than a timer.
//    Each of those is asserted uncounted below.
//
// The poll-interval exclusion is the load-bearing half of the rule and is
// asserted for the new shape too: a wait that is the pause between iterations
// of a loop re-checking a condition is deterministic and must stay uncounted,
// including the brace-less one-line loop body the scanner handles separately.
//
// Hermetic: the scanner reads source text, so no regtest venue is involved.

const assert  = require('assert')
const scanner = require('../../../scripts/check-sleep-flake')

const linesOf = (src) => scanner.scanSource(src, 'fixture.js').hits.map((h) => h.line)
const countOf = (src) => scanner.scanSource(src, 'fixture.js').hits.length

function registerFixedSettleTests() {
    describe('counts a fixed settle', function () {

        it('counts the helper form', function () {
            assert.strictEqual(countOf([
                'async function t() {',
                '    await send()',
                '    await sleep(5000)',
                '    assert.ok(row)',
                '}',
            ].join('\n')), 1)
        })

        it('counts the inline timer-promise form', function () {
            assert.deepStrictEqual(linesOf([
                'async function t() {',
                '    await send()',
                '    await new Promise(r => setTimeout(r, 5000))',
                '    assert.ok(row)',
                '}',
            ].join('\n')), [3])
        })

        it('counts the parenthesized-parameter and block-bodied spellings', function () {
            assert.strictEqual(countOf([
                'async function t() {',
                '    await new Promise((r) => setTimeout(r, SETTLE_MS));',
                '    await new Promise(res => { setTimeout(res, 2000) });',
                '}',
            ].join('\n')), 2)
        })
    })
}

function registerPollIntervalTests() {
    describe('does not count a poll interval', function () {

        it('skips the inline form as the last step of a re-checking loop', function () {
            assert.strictEqual(countOf([
                'async function waitFor(check) {',
                '    while (Date.now() < deadline) {',
                '        if (await check()) return true',
                '        await new Promise(r => setTimeout(r, 2000))',
                '    }',
                '}',
            ].join('\n')), 0)
        })

        it('skips the brace-less one-line loop body', function () {
            assert.strictEqual(countOf([
                'async function t() {',
                '    while (!(await check())) await new Promise(r => setTimeout(r, 500))',
                '}',
            ].join('\n')), 0)
        })
    })
}

function registerNonWaitTests() {
    describe('does not count things that are not waits on a duration', function () {

        it('skips a sleep helper definition', function () {
            assert.strictEqual(countOf([
                'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
                'function sleep2(ms) { return new Promise(r => setTimeout(r, ms)) }',
            ].join('\n')), 0)
        })

        it('skips a Promise.race timeout arm', function () {
            assert.strictEqual(countOf([
                'async function withTimeout(p, ms) {',
                '    return Promise.race([',
                '        p,',
                '        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),',
                '    ])',
                '}',
            ].join('\n')), 0)
        })

        it('skips an event wait with no timer', function () {
            assert.strictEqual(countOf([
                'async function t() {',
                '    await new Promise(resolve => ws.on("open", resolve))',
                '}',
            ].join('\n')), 0)
        })
    })
}

function registerOffsetHandlingTests() {
    describe('reads each hit at its own offset', function () {

        it('counts both waits when two share a line', function () {
            assert.deepStrictEqual(linesOf([
                'async function t() {',
                '    await mine(1); await sleep(3000)',
                '}',
            ].join('\n')), [2])
        })

        it('does not let a loop header AFTER the wait mask it', function () {
            // Only a loop header BEFORE the wait's own offset makes it a
            // brace-less loop body: the prefix is cut at that offset, so a
            // `for (` later on the line is not this hit's prefix and cannot erase it.
            assert.deepStrictEqual(linesOf([
                'async function t() {',
                '    await new Promise(r => setTimeout(r, 1000)); for (const x of xs) await x()',
                '}',
            ].join('\n')), [2])
        })
    })
}

function registerLoopSettleTests() {
    it('counts a settle inside a data-iteration loop', function () {
        assert.deepStrictEqual(linesOf([
            'async function t() {',
            '    for (const c of cases) {',
            '        await send(c)',
            '        await sleep(5000)',
            '    }',
            '}',
        ].join('\n')), [4])
    })

    it('counts the settle that FOLLOWS a brace-less poll loop on one line', function () {
        // The poll interval is the loop body and ends at its own `;`; the
        // second wait is a separate statement and separate debt.
        assert.deepStrictEqual(linesOf([
            'async function t() {',
            '    while (!ready) await sleep(100); await sleep(5000)',
            '}',
        ].join('\n')), [2])
    })

    it('counts a settle in a callback that merely sits in a loop body', function () {
        // Crossing into a function body ends the exemption: the callback does
        // not run as an iteration of the loop enclosing its definition.
        assert.deepStrictEqual(linesOf([
            'async function t() {',
            '    while (!done) {',
            '        if (await check()) break',
            '        register(async () => { await sleep(3000) })',
            '        await sleep(100)',
            '    }',
            '}',
        ].join('\n')), [4])
    })

    it('counts a `while (true)` body that can never leave', function () {
        assert.strictEqual(countOf([
            'async function t() {',
            '    while (true) { await sleep(1000) }',
            '}',
        ].join('\n')), 1)
    })
}

function registerLoopPollTests() {
    it('still exempts the real poll shapes', function () {
        const poll = (src) => countOf(src.join('\n'))
        assert.strictEqual(poll([
            'async function t() {',
            '    while (true) { await sleep(1000); if (await check()) break }',
            '}',
        ]), 0, 'while (true) with an exit is a poll')
        assert.strictEqual(poll([
            'async function t() {',
            '    for (let i = 0; i < 20; i++) { if (await ok()) break; await sleep(500) }',
            '}',
        ]), 0, 'bounded retry loop with an exit is a poll')
        assert.strictEqual(poll([
            'async function t() {',
            '    do { await sleep(500) } while (!(await ok()))',
            '}',
        ]), 0, 'do/while reads its test from the tail')
    })
}

function registerLoopClassificationTests() {
    describe('only a loop that re-checks a condition exempts its waits', function () {
        // A "lexically inside any loop" exemption is not the rule the header
        // states. Each case below counts 0 under that looser rule and each is a
        // plain fixed settle: the loop re-checks nothing, or the wait is not part
        // of the loop at all.
        registerLoopSettleTests()
        registerLoopPollTests()
    })
}

function registerRatchetTests() {
    describe('the ratchet gate', function () {

        it('counts every site in a file whose braces do not balance', function () {
            // A scanner defect must not quietly lower the baseline, so an
            // unparseable file forfeits the loop exclusion rather than the hit.
            const src = [
                'async function t() {',
                '    while (true) {',
                '        await new Promise(r => setTimeout(r, 1000))',
            ].join('\n')
            const res = scanner.scanSource(src, 'fixture.js')
            assert.strictEqual(res.balanced, false)
            assert.strictEqual(res.hits.length, 1)
        })
    })
}

describe('check-sleep-flake scanner', function () {
    registerFixedSettleTests()
    registerPollIntervalTests()
    registerNonWaitTests()
    registerOffsetHandlingTests()
    registerLoopClassificationTests()
    registerRatchetTests()
})
