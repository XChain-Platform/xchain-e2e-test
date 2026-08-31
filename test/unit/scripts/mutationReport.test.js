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

// The generator had been written against an ASSUMED Stryker report contract
// rather than the real mutation-testing-report-schema, and both halves of that
// drift were invisible in the output:
//
//  - PHANTOM FIELD: it read `m.originalLines`, which no version of the schema
//    emits, so `**Original:**` never rendered. The committed real run
//    reports/mutation/report-2026-04-07.md has 650 `**Mutant:**` lines and zero
//    `**Original:**` lines, and nobody noticed for months because the script
//    still ran, still wrote a file, and still looked healthy. The pre-mutation
//    text is on `files[path].source` (schema-required) with the mutant's 1-based,
//    end-exclusive `location`, so the guards below pin the extraction AND pin
//    that a phantom field alone yields nothing.
//  - SPLIT DENOMINATOR: the per-file score divided by `total - noCoverage` while
//    the overall score divided by `total - noCoverage - ignored`, so the two
//    numbers were different metrics and the worst-first sort ranked on the
//    divergent one. It was latent only because Ignored / RuntimeError /
//    CompileError were all zero in every run so far; the one-file invariant below
//    is what makes that divergence loud instead of silent.
//
// The tier is hermetic: fixtures are literal objects, so nothing here needs a
// Stryker run, a venue, or the gitignored reports/mutation/*.json artifacts.

const assert = require('assert')
const script = require('../../../scripts/mutation-report')

// A tiny file with a known layout, so every column below is countable by hand.
//   line 1: function ping(ms) {
//   line 2:     return ms > 0
//   line 3: }
const SOURCE = 'function ping(ms) {\n    return ms > 0\n}\n'

const BINARY_LOC = { start: { line: 2, column: 12 }, end: { line: 2, column: 18 } }
const BLOCK_LOC  = { start: { line: 1, column: 19 }, end: { line: 3, column: 2 } }

function mutant(overrides) {
    return Object.assign({ id: 'm', mutatorName: 'X', status: 'Survived', location: BINARY_LOC }, overrides)
}

function oneFileReport(mutants, source = SOURCE) {
    return { files: { 'src/ping.js': { language: 'javascript', source, mutants } } }
}

describe('mutation-report generator fidelity', () => {

    describe('pre-mutation snippets come from the report own source', () => {

        it('slices a single-line span with 1-based columns and an exclusive end', () => {
            // Off-by-one here is the whole risk of the fix: one column either way
            // silently yields a plausible neighbouring fragment, not an error.
            assert.strictEqual(script.sliceSource(SOURCE, BINARY_LOC), 'ms > 0')
        })

        it('slices a span that crosses lines', () => {
            assert.strictEqual(script.sliceSource(SOURCE, BLOCK_LOC), '{\n    return ms > 0\n}')
        })

        it('refuses rather than inventing a snippet when the report cannot support one', () => {
            assert.strictEqual(script.sliceSource(undefined, BINARY_LOC), null, 'absent source')
            assert.strictEqual(script.sliceSource(SOURCE, undefined), null, 'absent location')
            assert.strictEqual(script.sliceSource(SOURCE, { start: { line: 1, column: 1 } }), null, 'no end')
            assert.strictEqual(script.sliceSource(SOURCE, {
                start: { line: 9, column: 1 }, end: { line: 9, column: 2 },
            }), null, 'line past end of source')
        })

        it('neutralises backticks and caps the snippet length', () => {
            // The row wraps its value in a single backtick, so an unescaped one
            // closes the span early and the rest of the line renders as prose.
            assert.strictEqual(script.inlineCode('a `b` c'), "a 'b' c")
            assert.strictEqual(script.inlineCode('a\n  b'), 'a b')
            const long = script.inlineCode('x'.repeat(400))
            assert.ok(long.length <= 120, 'snippet capped, got ' + long.length)
            assert.ok(long.endsWith('...'), 'truncation is visible')
        })

        it('renders an Original line for every Mutant line', () => {
            const built = script.buildReport(oneFileReport([mutant({ replacement: '0' })]))
            assert.match(built.md, /- \*\*Original:\*\* `ms > 0`/)
            assert.match(built.md, /- \*\*Mutant:\*\* `0`/)
            assert.strictEqual(built.unextractable, 0)
        })

        it('emits nothing from a phantom originalLines field, and counts the miss', () => {
            // The negative control for the defect itself: a mutant carrying the
            // phantom originalLines field, and no location to slice with, must
            // produce no Original line at all. An Original line here means the
            // generator is reading that field instead of slicing the source.
            const built = script.buildReport(oneFileReport([
                { id: 'm', mutatorName: 'X', status: 'Survived', originalLines: 'ms > 0', mutatedLines: '0' },
            ]))
            assert.doesNotMatch(built.md, /\*\*Original:\*\*/)
            assert.doesNotMatch(built.md, /\*\*Mutant:\*\*/)
            assert.strictEqual(built.unextractable, 1, 'the unrenderable mutant is counted, not swallowed')
        })
    })

    describe('one score definition, per-file and overall alike', () => {

        it('scores over covered mutants only', () => {
            assert.strictEqual(script.coveredScore({ killed: 3, timeout: 1, survived: 1 }), '80.0')
            assert.strictEqual(script.coveredScore({ killed: 0, timeout: 0, survived: 0 }), 'N/A')
        })

        it('gives a lone file the same score as the report, with invalid mutants present', () => {
            // THE invariant the split denominator broke. With one file, the
            // per-file row and the header are computed over the same mutants, so
            // any denominator disagreement shows up as two different numbers.
            // Pre-fix this fixture printed 50.0% per-file against 66.7% overall.
            const built = script.buildReport(oneFileReport([
                mutant({ status: 'Killed' }),
                mutant({ status: 'Killed' }),
                mutant({ status: 'Survived' }),
                mutant({ status: 'NoCoverage' }),
                mutant({ status: 'Ignored' }),
                mutant({ status: 'RuntimeError' }),
                mutant({ status: 'CompileError' }),
            ]))
            assert.strictEqual(built.perFile.length, 1)
            assert.strictEqual(built.perFile[0].score, built.overallScore,
                'per-file score and overall score must be the same metric')
            assert.strictEqual(built.overallScore, '66.7', '2 killed of 3 covered')
        })

        it('reproduces the published headline on the shape of a real run', () => {
            // reports/mutation/report-2026-04-07.md: 3705 mutants, 1640 killed,
            // 30 timeout, 650 survived, 1385 no-coverage, 72.0%. The fix must not
            // move a number that has already been published.
            assert.strictEqual(script.coveredScore({ killed: 1640, timeout: 30, survived: 650 }), '72.0')
        })

        it('states the denominator in the report instead of leaving it to be inferred', () => {
            const built = script.buildReport(oneFileReport([mutant({ status: 'Killed' })]))
            assert.match(built.md, /covered-code mutation score/)
        })
    })

    describe('worst-first ranking survives an unscorable file', () => {

        it('sorts N/A last instead of scrambling the order', () => {
            // parseFloat('N/A') is NaN, and a comparator returning NaN leaves the
            // WHOLE ordering undefined, not just one row's place. Reachable the
            // moment any file's mutants are all NoCoverage or all Ignored.
            const built = script.buildReport({
                files: {
                    'src/low.js':  { language: 'javascript', source: SOURCE, mutants: [mutant({ status: 'Survived' })] },
                    'src/none.js': { language: 'javascript', source: SOURCE, mutants: [mutant({ status: 'Ignored' })] },
                    'src/high.js': { language: 'javascript', source: SOURCE, mutants: [mutant({ status: 'Killed' })] },
                },
            })
            assert.deepStrictEqual(built.perFile.map(f => f.file),
                ['src/low.js', 'src/high.js', 'src/none.js'])
            assert.strictEqual(built.perFile[2].score, 'N/A')
        })

        it('still puts critical-path files ahead of an unscorable one', () => {
            const built = script.buildReport({
                files: {
                    'src/none.js': { language: 'javascript', source: SOURCE, mutants: [mutant({ status: 'Ignored' })] },
                    'src/db.js':   { language: 'javascript', source: SOURCE, mutants: [mutant({ status: 'Killed' })] },
                },
            })
            assert.strictEqual(built.perFile[0].file, 'src/db.js')
            assert.strictEqual(built.perFile[0].critical, true)
        })
    })
})
