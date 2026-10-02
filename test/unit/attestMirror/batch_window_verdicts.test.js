'use strict'

const assert = require('assert')

const {
    oneValidHeadVerdict,
    emptyWindowVerdict,
} = require('../../attestMirror/helpers/batchWindowVerdicts')

describe('batch window verdicts', function () {
    describe('oneValidHeadVerdict', function () {
        it('accepts one valid v5 head and ignores other windows and continuations', function () {
            const head = { version: 5, batch_window_start: 100, verdict: 'valid' }
            const result = oneValidHeadVerdict([
                head,
                { version: 5, batch_window_start: 200, verdict: 'valid' },
                { version: 6, batch_window_start: 100, verdict: 'valid' },
            ], 100)

            assert.strictEqual(result.ok, true)
            assert.deepStrictEqual(result.heads, [head])
            assert.strictEqual(result.valid, head)
            assert.deepStrictEqual(result.duplicates, [])
        })

        it('accepts a valid head beside an invalid head for the same window', function () {
            const invalid = { version: 5, batch_window_start: 100, verdict: 'invalid' }
            const valid = { version: 5, batch_window_start: 100, verdict: 'valid' }
            const result = oneValidHeadVerdict([invalid, valid], 100)

            assert.strictEqual(result.ok, true)
            assert.deepStrictEqual(result.heads, [invalid, valid])
            assert.strictEqual(result.valid, valid)
            assert.deepStrictEqual(result.duplicates, [])
        })

        it('rejects two valid heads and reports every further valid head as a duplicate', function () {
            const first = { version: 5, batch_window_start: 100, verdict: 'valid' }
            const second = { version: 5, batch_window_start: 100, verdict: 'valid' }
            const result = oneValidHeadVerdict([first, second], 100)

            assert.strictEqual(result.ok, false)
            assert.strictEqual(result.valid, first)
            assert.deepStrictEqual(result.duplicates, [second])
        })

        it('rejects a window with no head', function () {
            const result = oneValidHeadVerdict([], 100)

            assert.strictEqual(result.ok, false)
            assert.deepStrictEqual(result.heads, [])
            assert.strictEqual(result.valid, null)
            assert.deepStrictEqual(result.duplicates, [])
        })

        it('compares string-typed versions and window starts numerically', function () {
            const head = { version: '5', batch_window_start: '100', verdict: 'valid' }
            const result = oneValidHeadVerdict([head], '100')

            assert.strictEqual(result.ok, true)
            assert.strictEqual(result.valid, head)
        })
    })

    describe('emptyWindowVerdict', function () {
        it('accepts a skipped zero-row marker without a matching head', function () {
            const marker = { window_start: 100, row_count: 0, status: 'skipped', hub: 1 }
            const result = emptyWindowVerdict([marker], [])

            assert.strictEqual(result.ok, true)
            assert.strictEqual(result.marker, marker)
            assert.deepStrictEqual(result.heads, [])
        })

        it('rejects a skipped zero-row marker with a matching head', function () {
            const marker = { window_start: 100, row_count: 0, status: 'skipped', hub: 1 }
            const head = { version: 5, batch_window_start: 100, batch_row_count: 0, verdict: 'valid' }
            const result = emptyWindowVerdict([marker], [head])

            assert.strictEqual(result.ok, false)
            assert.strictEqual(result.marker, marker)
            assert.deepStrictEqual(result.heads, [head])
        })

        it('rejects a zero-row marker in sent status', function () {
            const marker = { window_start: 100, row_count: 0, status: 'sent', hub: 1 }
            const result = emptyWindowVerdict([marker], [])

            assert.strictEqual(result.ok, false)
            assert.strictEqual(result.marker, null)
            assert.deepStrictEqual(result.heads, [])
        })

        it('compares string-typed marker and action numbers numerically', function () {
            const covered = { window_start: '100', row_count: '0', status: 'skipped', hub: 1 }
            const quiet = { window_start: '200', row_count: '0', status: 'skipped', hub: 2 }
            const actions = [
                { version: '5', batch_window_start: '100', batch_row_count: '0', verdict: 'valid' },
                { version: '6', batch_window_start: '200', batch_row_count: '0', verdict: 'valid' },
            ]
            const result = emptyWindowVerdict([covered, quiet], actions)

            assert.strictEqual(result.ok, true)
            assert.strictEqual(result.marker, quiet)
            assert.deepStrictEqual(result.heads, [])
        })
    })
})
