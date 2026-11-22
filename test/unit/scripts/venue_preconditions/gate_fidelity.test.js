'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const acorn = require('acorn')
const mirror = require('../../../../bin/check-mirror-pendings')
const requestRows = require('../../../../bin/check-request-row-wait')
const sleepFlake = require('../../../../bin/check-sleep-flake')
const stakeGate = require('../../../../bin/check-stake-teardown')
const { AMBIGUOUS_TEMPLATE, templateLiteralEnd } = require('../../../../bin/lib/template_literal')

const nestedTemplate = "const note = `${names.map((n) => `${n}'s venue`).join(', ')}`"

// A slash after `for await (...)` cannot be settled from the token before it;
// read as division, the next brace closes the interpolation early.
const unsettledTemplate = "const shown = `${[async () => { for await (const row of rows) /}/.test(row) }, `it's`]}`"

const SETTLED_BODIES = [
    'a.in / b / c',
    'x.if(y) / 2 / 3',
    'a.return / 2 / 3',
    'count++ / d / 2',
    'fn(a) / 2 / 3',
    '(() => { if (ok) /}/.test(v) })',
    '(() => { do x; while (ok) /}/.test(v) })',
    '(() => { for (const v of w) /`/.test(v) })',
    'typeof /}/',
    '[...typeof /`/]',
    "values.filter((v) => /'/.test(v)).map((v) => `${v}'s`)",
    '(() => { lbl: for (;;) { break\n/}/.test(v) } })',
    'class extends /}/ {}',
    '`${`}`}`',
]

const UNSETTLED_BODIES = [
    "[async () => { for await (const x of y) /}/.test(x) }, `it's`]",
    "[() => { function f () {} /}/.test(v) }, `it's`]",
    "[() => { class A {} /}/.test(v) }, `it's`]",
    "[() => { try {} catch {} /}/.test(v) }, `it's`]",
    "[() => { { } /}/.test(v) }, `it's`]",
    '{ value: 1 } / d / 2',
    'function () {} / 2 / 3',
    '(function* () { yield /}/ })',
    '(async () => { await /}/.test(v) })',
    '(() => { let of = 4; return of / 2 / 1 })',
    'a <!--b }\n',
]

const QUOTED_TAIL = "${names.map((n) => `${n}'s venue`).join(', ')}"

function wrapped (body) {
    return 'v = `A${' + body + '}B' + QUOTED_TAIL + '`; z / 1 / 2'
}

function acornEnd (source) {
    const program = acorn.parse(source, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true })
    return program.body[0].expression.right.end
}

describe('venue precondition gate lexer fidelity', function () {
    it('finds a declared skip after a quote-bearing arrow regex', function () {
        const source = [
            "describe('AT13', function () {",
            "  const quoted = lines.filter((line) => /'/.test(line))",
            "  it.skip('hidden behind a quoted regex', function () {})",
            '})',
        ].join('\n')

        const pending = mirror.parseSource(source, 'at13.test.js').pending
        assert.deepStrictEqual(pending.map((entry) => entry.claim), ['hidden behind a quoted regex'])
    })

    it('finds a runtime skip after a quote-bearing arrow regex', function () {
        const source = [
            'describe("AT13", function () {',
            '  it("runtime case", function () {',
            "    const quoted = lines.filter((line) => /'/.test(line))",
            '    this.skip()',
            '  })',
            '})',
        ].join('\n')

        const pending = mirror.parseSource(source, 'at13.test.js').pending
        assert.deepStrictEqual(pending.map((entry) => entry.claim), ['runtime case'])
    })

    it('still finds a skip after ordinary division', function () {
        const source = "const half = total / 2\nit.skip('division control', function () {})"
        const pending = mirror.parseSource(source, 'at13.test.js').pending
        assert.deepStrictEqual(pending.map((entry) => entry.claim), ['division control'])
    })
})

describe('venue precondition gates after a template literal', function () {
    it('finds a skip after postfix increment division inside a template', function () {
        const source = [
            'const ratio = `x${count++ / divisor}` / 2',
            "it.skip('postfix division control', function () {})",
        ].join('\n')
        const pending = mirror.parseSource(source, 'at13.test.js').pending
        assert.deepStrictEqual(pending.map((entry) => entry.claim), ['postfix division control'])
    })

    it('finds declared and runtime skips after a nested template', function () {
        const source = [
            nestedTemplate,
            "it.skip('declared after template', function () {})",
            'it("runtime after template", function () { this.skip() })',
        ].join('\n')

        const pending = mirror.parseSource(source, 'at14.test.js').pending
        assert.deepStrictEqual(pending.map((entry) => entry.claim), [
            'declared after template',
            'runtime after template',
        ])
    })

    it('finds a raw stake after a nested template', function () {
        const source = [nestedTemplate, "let msg = 'STAKE|1|' + amount"].join('\n')
        const hits = stakeGate.scanLines(source.split('\n'), 'test/actions/nested-template.test.js')
        assert.deepStrictEqual(hits.map((entry) => entry.line), [2])
    })

    it('keeps object braces inside a stake template interpolation opaque', function () {
        const source = "let msg = `STAKE|1|${format({ amount })}|${signingPubkey}`"
        const hits = stakeGate.scanLines([source], 'test/actions/template-braces.test.js')
        assert.deepStrictEqual(hits.map((entry) => entry.line), [1])
    })

    it('finds a fixed sleep after a nested template', function () {
        const source = [
            'async function settle() {',
            `  ${nestedTemplate}`,
            '  await new Promise((resolve) => setTimeout(resolve, 1000))',
            '}',
        ].join('\n')
        assert.deepStrictEqual(sleepFlake.scanSource(source, 'fixture.js').hits.map((entry) => entry.line), [3])
    })

    it('finds an unguarded request row read after a nested template', function () {
        const source = [
            'async function check(requestId) {',
            `  ${nestedTemplate}`,
            '  await waitForMirrorRowEverywhere(venue, requestId)',
            '  return readRequestRow(venue, 0, requestId)',
            '}',
        ].join('\n')
        const hits = requestRows.scanSource(source, 'fixture.test.js')
        assert.strictEqual(hits.length, 1)
        assert.strictEqual(hits[0].status, 'unguarded')
    })
})

describe('template literal boundary scanner', function () {
    for (const source of [
        '`plain`',
        '`${format({ amount: 1 })}`',
        "`${names.map((name) => `${name}'s venue`).join(', ')}`",
        "`${'`'}`",
        '`${value /* a } in a comment */}`',
        '`${values.filter((value) => /}/.test(value))}`',
        '`escaped\\`tick`',
    ]) {
        it(`finds the end of ${source}`, function () {
            assert.strictEqual(templateLiteralEnd(source, 0), source.length)
        })
    }

    it('returns the source end for an unterminated template', function () {
        const source = '`unterminated ${value'
        assert.strictEqual(templateLiteralEnd(source, 0), source.length)
    })

    it('stops before division following a postfix expression interpolation', function () {
        const source = '`x${count++ / divisor}` / 2'
        assert.strictEqual(templateLiteralEnd(source, 0), source.indexOf('`', 1) + 1)
    })

    it('refuses a slash after a closing brace when a regex could close on that line', function () {
        for (const source of [
            '`x${{ value: 1 } / divisor}` / 2',
            '`x${(() => { if (ok) {} /}/.test(value); return 1 })()}` / 2',
        ]) {
            assert.throws(() => templateLiteralEnd(source, 0), { code: AMBIGUOUS_TEMPLATE })
        }
    })

    it('reads a slash after a closing brace as division when no regex could close on its line', function () {
        const source = '`x${{ value: 1 } / divisor}`'
        assert.strictEqual(templateLiteralEnd(source, 0), source.length)
    })

    it('finds the exact end acorn finds when the previous token settles every slash', function () {
        for (const body of SETTLED_BODIES) {
            const source = wrapped(body)
            assert.strictEqual(templateLiteralEnd(source, 4), acornEnd(source), body)
        }
    })

    it('matches acorn or refuses on unsettled slashes, never returning a different end', function () {
        for (const body of UNSETTLED_BODIES) {
            const source = wrapped(body)
            let found = null
            try {
                found = templateLiteralEnd(source, 4)
            } catch (error) {
                assert.strictEqual(error.code, AMBIGUOUS_TEMPLATE, body)
            }
            if (found !== null) assert.strictEqual(found, acornEnd(source), body)
        }
    })
})

describe('gates refuse a template they cannot bound', function () {
    const assertRefused = (scan, file) => assert.throws(scan, (error) =>
        error.code === AMBIGUOUS_TEMPLATE && error.message.startsWith(file + ': '))

    it('mirror pendings refuses instead of losing a later skip', function () {
        const source = [unsettledTemplate, "it.skip('declared after template', function () {})"].join('\n')
        assert.throws(() => mirror.parseSource(source, 'at14.test.js'), { code: AMBIGUOUS_TEMPLATE })
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-template-'))
        fs.writeFileSync(path.join(dir, 'refusal.test.js'), source)
        assert.throws(() => mirror.scanPaths([dir]), (error) =>
            error.code === AMBIGUOUS_TEMPLATE && error.message.includes('refusal.test.js: '))
    })

    it('stake teardown refuses instead of losing a later raw stake', function () {
        const file = 'test/actions/unsettled-template.test.js'
        assertRefused(() => stakeGate.scanLines([unsettledTemplate, "let msg = 'STAKE|1|' + amount"], file), file)
    })

    it('sleep flake refuses instead of losing a later fixed sleep', function () {
        const source = [
            'async function settle() {',
            `  ${unsettledTemplate}`,
            '  await new Promise((resolve) => setTimeout(resolve, 1000))',
            '}',
        ].join('\n')
        assertRefused(() => sleepFlake.scanSource(source, 'fixture.js'), 'fixture.js')
    })

    it('request row wait refuses instead of losing a later unguarded read', function () {
        const source = [
            'async function check(requestId) {',
            `  ${unsettledTemplate}`,
            '  return readRequestRow(venue, 0, requestId)',
            '}',
        ].join('\n')
        assertRefused(() => requestRows.scanSource(source, 'fixture.test.js'), 'fixture.test.js')
    })
})

describe('stake helper registration coverage', function () {
    const registrar = 'test/helpers/stakeHelper.js'

    it('flags an unbooked raw stake in the helper', function () {
        const hits = stakeGate.scanLines(["let msg = 'STAKE|1|' + amount"], registrar)
        assert.strictEqual(hits.length, 1)
    })

    it('accepts one booking for one raw stake in the helper', function () {
        const hits = stakeGate.scanLines([
            "let msg = 'STAKE|1|' + amount",
            'stakeTeardown.bookBroadcastStake({ addressInfo, signingPubkey, amount })',
        ], registrar)
        assert.strictEqual(hits.length, 0)
    })

    it('flags two raw stakes with only one booking', function () {
        const hits = stakeGate.scanLines([
            "let first = 'STAKE|1|' + amount",
            "let second = 'STAKE|2|' + amount",
            'stakeTeardown.bookBroadcastStake({ addressInfo, signingPubkey, amount })',
        ], registrar)
        assert.strictEqual(hits.length, 2)
    })
})
