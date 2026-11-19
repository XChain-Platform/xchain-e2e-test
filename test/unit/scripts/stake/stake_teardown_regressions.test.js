'use strict'

const assert = require('assert')
const gate = require('../../../../bin/check-stake-teardown')
const { lineComments } = require('../../../../bin/lib/line_comments')

const REGISTER = 'stakeTeardown.bookBroadcastStake({ addressInfo: addr, signingPubkey: pk, amount: 1 })'
const scan = (source) => gate.scanLines(source.split('\n'), 'test/actions/regression.test.js')

describe('check-stake-teardown origin fidelity', function () {
    it('reports both same-line broadcasts when only one is booked', function () {
        const hits = scan("let a = 'STAKE|1|1000|' + pkA; let b = 'STAKE|1|1000|' + pkB\n" + REGISTER)
        assert.deepStrictEqual(hits.map((hit) => hit.line), [1, 1])
    })

    it('accepts two same-line broadcasts when both are booked', function () {
        const source = "let a = 'STAKE|1|1000|' + pkA; let b = 'STAKE|1|1000|' + pkB\n" +
            REGISTER + '\n' + REGISTER
        assert.strictEqual(scan(source).length, 0)
    })

    it('deduplicates one broadcast reached through several scan paths', function () {
        const source = "const msg = 'STAKE|1|' + pk; await tx.createAndSendTransaction(addr, msg)\n" + REGISTER
        assert.strictEqual(scan(source).length, 0)
    })

    it('deduplicates a broadcast assembled from a bound prefix', function () {
        const source = "const prefix = 'STAKE|1|'; const msg = prefix + pk\n" + REGISTER
        assert.strictEqual(scan(source).length, 0)
    })

    it('counts distinct calls that share one payload prefix', function () {
        const source = ["const prefix = 'STAKE|1|1000|'",
            'await tx.createAndSendTransaction(addrA, prefix + pkA)',
            'await tx.createAndSendTransaction(addrB, prefix + pkB)', REGISTER].join('\n')
        assert.deepStrictEqual(scan(source).map((hit) => hit.line), [2, 3])
    })

    it('accepts shared-prefix calls when every broadcast is booked', function () {
        const source = ["const prefix = 'STAKE|1|1000|'",
            'await tx.createAndSendTransaction(addrA, prefix + pkA)',
            'await tx.createAndSendTransaction(addrB, prefix + pkB)', REGISTER, REGISTER].join('\n')
        assert.strictEqual(scan(source).length, 0)
    })

    it('honors an origin opt-out across shared-prefix calls', function () {
        const source = ['// stake-teardown-ok: rejected on the zero amount guard',
            "const prefix = 'STAKE|1|0|'",
            'await tx.createAndSendTransaction(addrA, prefix + pkA)',
            'await tx.createAndSendTransaction(addrB, prefix + pkB)'].join('\n')
        assert.strictEqual(scan(source).length, 0)
    })
})

describe('check-stake-teardown booking fidelity', function () {
    it('rejects bookings whose first argument cannot register a stake', function () {
        const calls = [
            'stakeTeardown.bookBroadcastStake()',
            'stakeTeardown.bookBroadcastStake(null)',
            'stakeTeardown.bookBroadcastStake({})',
            'stakeTeardown.bookBroadcastStake({ addressInfo: addr })',
            'stakeTeardown.bookBroadcastStake({ signingPubkey: pk })',
            'stakeTeardown.bookBroadcastStake({ addressInfo: addr, signingPubkey: null })',
        ]
        for (const call of calls) {
            assert.strictEqual(scan("let msg = 'STAKE|1|1000|' + pk\n" + call).length, 1, call)
        }
    })

    it('rejects bookings whose required values are statically falsy', function () {
        const specs = [
            '{ addressInfo: 0, signingPubkey: pk }',
            "{ addressInfo: addr, signingPubkey: '' }",
            '{ addressInfo: void 0, signingPubkey: pk }',
            '{ addressInfo: addr, signingPubkey: false }',
            '{ addressInfo: addr, signingPubkey: `` }',
            '{ addressInfo: addr, signingPubkey: (null) }',
            '{ addressInfo: addr, signingPubkey: pk, addressInfo: null }',
        ]
        for (const spec of specs) {
            const call = 'stakeTeardown.bookBroadcastStake(' + spec + ')'
            assert.strictEqual(scan("let msg = 'STAKE|1|1000|' + pk\n" + call).length, 1, call)
        }
    })

    it('rejects a shorthand or named value bound to a falsy literal', function () {
        const header = "let msg = 'STAKE|1|1000|' + pk\nconst addressInfo = null\nconst empty = ''\n"
        const calls = [
            'stakeTeardown.bookBroadcastStake({ addressInfo, signingPubkey: pk })',
            'stakeTeardown.bookBroadcastStake({ addressInfo: addr, signingPubkey: empty })',
        ]
        for (const call of calls) assert.strictEqual(scan(header + call).length, 1, call)
    })

    it('accepts a shorthand value bound to an opaque expression', function () {
        const source = "let msg = 'STAKE|1|1000|' + pk\nconst addressInfo = await lookup()\n" +
            'stakeTeardown.bookBroadcastStake({ addressInfo, signingPubkey: pk })'
        assert.strictEqual(scan(source).length, 0)
    })

    it('accepts a multiline object with both required values', function () {
        const source = ["let msg = 'STAKE|1|1000|' + pk", 'stakeTeardown.bookBroadcastStake({',
            '    addressInfo: addr,', '    signingPubkey: pk,', '})'].join('\n')
        assert.strictEqual(scan(source).length, 0)
    })

    it('rejects bookings whose earlier required keys can be overridden', function () {
        const specs = [
            '{ addressInfo: addr, signingPubkey: pk, ...{ signingPubkey: null } }',
            '{ addressInfo: addr, signingPubkey: pk, ...overrides }',
            "{ addressInfo: addr, signingPubkey: pk, ['signingPubkey']: null }",
            '{ ...spec }',
        ]
        for (const spec of specs) {
            const call = 'stakeTeardown.bookBroadcastStake(' + spec + ')'
            assert.strictEqual(scan("let msg = 'STAKE|1|1000|' + pk\n" + call).length, 1, call)
        }
    })

    it('accepts explicit required keys after an unknown member', function () {
        const specs = [
            '{ ...base, addressInfo: addr, signingPubkey: pk }',
            '{ addressInfo: addr, ...base, signingPubkey: pk, addressInfo: addr }',
        ]
        for (const spec of specs) {
            const call = 'stakeTeardown.bookBroadcastStake(' + spec + ')'
            assert.strictEqual(scan("let msg = 'STAKE|1|1000|' + pk\n" + call).length, 0, call)
        }
    })
})

describe('check-stake-teardown comment fidelity', function () {
    it('does not treat marker text in strings or templates as a comment', function () {
        const marker = '// stake-teardown-ok: rejected for zero amount'
        assert.strictEqual(scan("let msg = 'STAKE|1|' + pk; const note = '" + marker + "'").length, 1)
        assert.strictEqual(scan("let msg = 'STAKE|1|' + pk; const note = `" + marker + "`").length, 1)
    })

    it('honors a real marker after a string containing double slashes', function () {
        const source = "let msg = 'STAKE|1|' + pk; const ref = 'proto://value' // " +
            'stake-teardown-ok: rejected for zero amount'
        assert.strictEqual(scan(source).length, 0)
    })

    it('honors a marker in the comment block directly above', function () {
        const source = "// stake-teardown-ok: rejected for zero amount\nlet msg = 'STAKE|1|' + pk"
        assert.strictEqual(scan(source).length, 0)
    })

    it('extracts real comments after regex literals but skips block comments', function () {
        const comments = lineComments("const re = /\\/\\// // kept comment\n/* stake-teardown-ok: not a line comment */")
        assert.strictEqual(comments.get(1).trim(), 'kept comment')
        assert.strictEqual(comments.has(2), false)
    })
})
