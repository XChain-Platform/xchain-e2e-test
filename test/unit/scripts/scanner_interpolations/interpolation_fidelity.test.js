'use strict'

const assert = require('assert')
const mirror = require('../../../../bin/check-mirror-pendings')
const requestRow = require('../../../../bin/check-request-row-wait')
const sleepFlake = require('../../../../bin/check-sleep-flake')

describe('scanner interpolation fidelity', function () {
    describe('mirror pending declarations', function () {
        it('detects masked comments and whitespace around a declared skip', function () {
            const sources = [
                "it /* annotation */ .skip('hidden claim', () => {})",
                "it\n  . skip('hidden claim', () => {})",
            ]
            for (const source of sources) {
                const parsed = mirror.parseSource(source, 'fixture.test.js')
                assert.strictEqual(parsed.pending.length, 1, source)
                assert.strictEqual(parsed.pending[0].kind, 'declared')
            }
        })

        it('counts cases hidden by a spaced skipped suite', function () {
            const source = "describe /* note */ .skip('suite', () => { it('inner', () => {}) })"
            const parsed = mirror.parseSource(source, 'fixture.test.js')
            assert.strictEqual(parsed.pending.length, 1)
            assert.match(parsed.pending[0].title, /skipped suite, 1 cases/)
        })

        it('does not treat similar member calls as declarations', function () {
            const source = "re.test(value); it.skipped('claim'); foo.it .skip('claim')"
            assert.deepStrictEqual(mirror.parseSource(source, 'fixture.test.js').pending, [])
        })
    })

    describe('mirror pending template code', function () {
        it('treats a template SKIPPED log naming venue.unavailable like the concatenated venue guard', function () {
            const guard = (log) => [
                "describe('venue leg', function () {",
                '  before(function () {',
                '    if (!up) {',
                '      ' + log,
                '      this.skip()',
                '    }',
                '  })',
                '})',
            ].join('\n')
            const concatenated = mirror.parseSource(guard("console.log('AT1 SKIPPED ' + ctx.venue.unavailable)"), 'at1.test.js')
            const templated = mirror.parseSource(guard('console.log(`AT1 SKIPPED ${ctx.venue.unavailable}`)'), 'at1.test.js')
            assert.deepStrictEqual(concatenated.pending, [])
            assert.deepStrictEqual(templated.pending, concatenated.pending)
        })

        it('detects a runtime skip inside an interpolation', function () {
            const source = "it('reads state', function () { console.log(`state: ${this.skip()}`) })"
            const parsed = mirror.parseSource(source, 'fixture.test.js')
            assert.strictEqual(parsed.pending.length, 1)
            assert.strictEqual(parsed.pending[0].kind, 'body')
        })

        it('detects a runtime skip inside a nested interpolation', function () {
            const source = "it('reads state', function () { console.log(`outer ${`inner ${this.skip()}`}`) })"
            assert.strictEqual(mirror.parseSource(source, 'fixture.test.js').pending.length, 1)
        })

        it('ignores skip text and strings inside interpolations', function () {
            const sources = [
                "it('reads state', function () { console.log(`call this.skip() later`) })",
                "it('reads state', function () { console.log(`state: ${'this.skip()'}`) })",
            ]
            for (const source of sources) {
                assert.deepStrictEqual(mirror.parseSource(source, 'fixture.test.js').pending, [], source)
            }
        })
    })

    it('detects a request-row read inside an interpolation but ignores template text', function () {
        const executable = 'const note = `row ${readRequestRow(venue, 0, requestId)}`'
        const textOnly = 'const note = `readRequestRow(venue, 0, requestId)`'
        assert.strictEqual(requestRow.scanSource(executable, 'fixture.test.js').length, 1)
        assert.strictEqual(requestRow.scanSource(textOnly, 'fixture.test.js').length, 0)
    })

    it('detects a fixed sleep inside an interpolation but ignores template text', function () {
        const executable = 'async function t() { console.log(`wait ${await sleep(5000)}`) }'
        const textOnly = 'async function t() { console.log(`await sleep(5000)`) }'
        assert.strictEqual(sleepFlake.scanSource(executable, 'fixture.test.js').hits.length, 1)
        assert.strictEqual(sleepFlake.scanSource(textOnly, 'fixture.test.js').hits.length, 0)
    })

    describe('regex literals inside interpolations', function () {
        const skipCount = (source) => mirror.parseSource(source, 'fixture.test.js').pending.length
        const readCount = (source) => requestRow.scanSource(source, 'fixture.test.js').length
        const sleepCount = (source) => sleepFlake.scanSource(source, 'fixture.test.js').hits.length

        it('masks a regex whose text looks like the pattern each gate scans for', function () {
            assert.strictEqual(readCount('const ok = `m ${/readRequestRow(venue, 0, requestId)/.test(s)}`'), 0)
            assert.strictEqual(readCount('const ok = `m ${`n ${/readRequestRow(venue, 0, id)/.test(s)}`}`'), 0)
            assert.strictEqual(skipCount("it('a', function () { log(tag`s ${/this.skip()/.test(x)}`) })"), 0)
            assert.strictEqual(sleepCount('async function t() { log(`w ${/await sleep(5000)/.test(x)}`) }'), 0)
        })

        it('keeps code after a regex holding a quote or backtick visible', function () {
            for (const re of ["/'/", '/`/']) {
                assert.strictEqual(readCount('const ok = `m ${' + re + '.test(s)} ${readRequestRow(venue, 0, id)}`'), 1, re)
                assert.strictEqual(skipCount("it('a', function () { log(`s ${" + re + '.test(x)} ${this.skip()}`) })'), 1, re)
                assert.strictEqual(sleepCount('async function t() { log(`w ${' + re + '.test(x)} ${await sleep(5000)}`) }'), 1, re)
            }
        })

        it('keeps code after a quote-bearing regex in the same interpolation visible', function () {
            for (const re of ["/'/", '/`/', '/"/']) {
                assert.strictEqual(readCount('const ok = `m ${' + re + '.test(s) && readRequestRow(venue, 0, id)}`'), 1, re)
                assert.strictEqual(skipCount("it('a', function () { log(`s ${" + re + '.test(x) && this.skip()}`) })'), 1, re)
                assert.strictEqual(sleepCount('async function t() { log(`w ${' + re + '.test(x) && await sleep(5000)}`) }'), 1, re)
            }
        })

        it('keeps a division inside an interpolation as code', function () {
            assert.strictEqual(readCount('const ok = `m ${a / b} ${readRequestRow(venue, 0, requestId)}`'), 1)
        })
    })
})
