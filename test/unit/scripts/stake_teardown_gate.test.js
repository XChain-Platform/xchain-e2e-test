'use strict'

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Coverage for the untracked-stake gate (scripts/check-stake-teardown.js).
 *
 * A hygiene gate that quietly stops matching is worse than no gate: the suite
 * reads as clean while the shared venue fills up again. So the matcher is
 * pinned on both sides - it must catch a raw STAKE broadcast, and it must not
 * cry about a payload that cannot leak - and the repo is asserted clean, so a
 * new bypass fails on a laptop before it reaches a venue.
 ********************************************************************/

const assert = require('assert')
const gate = require('../../../scripts/check-stake-teardown')

const scan = (src, rel) => gate.scanLines(src.split('\n'), rel || 'test/actions/example.test.js')

describe('check-stake-teardown gate', () => {

    it('catches a hand-built STAKE broadcast', () => {
        const hits = scan([
            "let msg = 'STAKE|1|1000.00000000|' + pubkey",
            "await transactionHelper.createAndSendTransaction(addr, msg)"
        ].join('\n'))
        assert.strictEqual(hits.length, 1)
        assert.strictEqual(hits[0].line, 1)
    })

    it('catches a STAKE version that does not exist yet', () => {
        assert.strictEqual(scan("let msg = 'STAKE|4|1|' + pubkey").length, 1,
            'a version-pinned matcher would miss the next wire version on the day it is written')
    })

    it('accepts a site that says why the stake can never become a member', () => {
        const hits = scan([
            "// stake-teardown-ok: rejected on the AMOUNT format guard.",
            "let msg = 'STAKE|1|1000.123456789|' + freshPubkey()"
        ].join('\n'))
        assert.strictEqual(hits.length, 0)
    })
})

describe('check-stake-teardown gate', () => {
    it('accepts the marker on the payload\'s own line', () => {
        assert.strictEqual(scan("let msg = 'STAKE|1|0|' + p // stake-teardown-ok: zero amount, always rejected").length, 0)
    })

    it('rejects a bare marker with no reason', () => {
        const hits = scan([
            "// stake-teardown-ok:",
            "let msg = 'STAKE|1|1000|' + pubkey"
        ].join('\n'))
        assert.strictEqual(hits.length, 1, 'the reason is the point: an empty marker is a pragma, not a judgement')
    })

    it('accepts a file that books its own debt with the release ledger', () => {
        const hits = scan([
            "await transactionHelper.createAndSendTransaction(addr, 'STAKE|1|' + amount + '|' + pubkey)",
            "stakeTeardown.registerStake({ addressInfo: addr, signingPubkey: pubkey, amount: amount })"
        ].join('\n'))
        assert.strictEqual(hits.length, 0)
    })
})

describe('check-stake-teardown gate', () => {
    it('does not flag a payload quoted in a comment', () => {
        const hits = scan([
            "// the wire form is 'STAKE|1|<amount>|<pubkey>'",
            " * and a top-up is \"STAKE|2|<amount>|<pubkey>\""
        ].join('\n'))
        assert.strictEqual(hits.length, 0)
    })

    it('exempts the registrar itself', () => {
        assert.strictEqual(scan("let msg = 'STAKE|1|' + amount", 'test/helpers/stakeHelper.js').length, 0)
    })

    it('the repo is clean: every STAKE broadcast under test/ is tracked or explained', () => {
        const hits = gate.scan()
        assert.deepStrictEqual(hits, [],
            'these STAKE broadcasts bypass the release ledger:\n' +
            hits.map(h => '  ' + h.file + ':' + h.line + '  ' + h.text).join('\n'))
    })
})

describe('check-stake-teardown gate: one registration per broadcast', () => {
    const REGISTER = "stakeTeardown.registerStake({ addressInfo: addr, signingPubkey: pk, amount: 1 })"

    it('flags both broadcasts when a file registers once and broadcasts twice', () => {
        const hits = scan(["let a = 'STAKE|1|1000|' + pkA", "let b = 'STAKE|1|1000|' + pkB", REGISTER].join('\n'))
        assert.deepStrictEqual(hits.map(h => h.line), [1, 2])
    })

    it('accepts two broadcasts booked by two registrations', () => {
        assert.strictEqual(scan(["let a = 'STAKE|1|1000|' + pkA", "let b = 'STAKE|1|1000|' + pkB", REGISTER, REGISTER].join('\n')).length, 0)
    })

    it('does not count a commented-out registration', () => {
        assert.strictEqual(scan(["let a = 'STAKE|1|1000|' + pkA", '// ' + REGISTER].join('\n')).length, 1)
    })

    it('does not spend a registration on an opted-out payload', () => {
        const hits = scan([
            '// stake-teardown-ok: rejected on the zero amount guard',
            "let a = 'STAKE|1|0|' + pkA",
            "let b = 'STAKE|1|1000|' + pkB",
            REGISTER,
        ].join('\n'))
        assert.strictEqual(hits.length, 0)
    })
})

describe('check-stake-teardown gate: payload delimiters', () => {
    it('catches a template-literal payload', () => {
        assert.strictEqual(scan('let msg = `STAKE|1|${amount}|${pk}`').length, 1)
    })

    it('catches a template-literal payload whose version is interpolated', () => {
        assert.strictEqual(scan('let msg = `STAKE|${version}|${amount}|${pk}`').length, 1)
        assert.strictEqual(scan('let msg = `UNSTAKE|${version}|${pk}`').length, 0)
    })

    it('catches a quoted STAKE joined to its version field', () => {
        assert.strictEqual(scan("let msg = 'STAKE' + '|1|' + amount").length, 1)
        assert.strictEqual(scan("let msg = 'STAKE|' + version + '|' + amount").length, 1)
    })

    it('does not flag an UNSTAKE payload in any delimiter', () => {
        assert.strictEqual(scan("let a = 'UNSTAKE|1|' + pk\nlet b = `UNSTAKE|1|${pk}`").length, 0)
    })
})

describe('check-stake-teardown gate: unresolved transaction payloads', () => {
    const scanPayload = (payload) => gate.scanLines([
        `await transactionHelper.createAndSendTransaction(tx, ${payload})`,
    ], 'test/actions/opaque_payload.test.js')

    it('catches a bare payload identifier passed directly to the transaction helper', () => {
        const hits = scan('await transactionHelper.createAndSendTransaction(tx, payload)')
        assert.deepStrictEqual(hits.map(h => h.line), [1])
    })

    it('keeps established non-stake opaque wrappers clean', () => {
        const hits = scan('await transactionHelper.createAndSendTransaction(tx, payload)',
            'test/helpers/rollcall_helper/chain_driving.js')
        assert.strictEqual(hits.length, 0)
    })

    for (const payload of ['payload', 'context.payload', 'payloads[index]',
        'usePrimary ? primaryPayload : fallbackPayload', 'primaryPayload || fallbackPayload']){
        it(`flags unresolved payload expression: ${payload}`, () => {
            const hits = scanPayload(payload)
            assert.strictEqual(hits.length, 1)
            assert.strictEqual(hits[0].line, 1)
        })
    }

    it('accepts a payload demonstrably built by stakeHelper', () => {
        assert.strictEqual(scanPayload('stakeHelper.sendStakeV1(tx, amount, pubkey)').length, 0)
    })

    it('accepts a bound payload demonstrably built by stakeHelper', () => {
        const hits = gate.scanLines([
            'const payload = stakeHelper.sendStakeV2(tx, amount, pubkey)',
            'await transactionHelper.createAndSendTransaction(tx, payload)',
        ], 'test/actions/helper_payload.test.js')
        assert.strictEqual(hits.length, 0)
    })
})

const markedPayload = (reason) => scan([
    '// stake-teardown-ok:' + reason,
    "let msg = 'STAKE|1|1000|' + pubkey"
].join('\n'))

describe('check-stake-teardown gate: the opt-out reason', () => {
    it('rejects a one-character reason', () => {
        assert.strictEqual(markedPayload(' x').length, 1, 'a throwaway marker is a pragma, not a judgement')
    })

    it('rejects a one-word or two-word reason', () => {
        assert.strictEqual(markedPayload(' rejected').length, 1)
        assert.strictEqual(markedPayload(' ok fine').length, 1)
    })

    it('does not count punctuation-only tokens as words', () => {
        assert.strictEqual(markedPayload(' rejected - .').length, 1)
    })

    it('accepts a three-word reason on the marker line', () => {
        assert.strictEqual(markedPayload(' rejected, zero amount').length, 0)
    })
})

const os = require('os')
const fs = require('fs')
const path = require('path')

function buildTree(files){
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stake-gate-'))
    for (const rel of files){
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
        fs.writeFileSync(path.join(root, rel), '')
    }
    return root
}

describe('check-stake-teardown gate: which directories are scanned', () => {
    it('skips only the top-level unit/ and codec/, and node_modules anywhere', () => {
        const root = buildTree(['unit/a.js', 'codec/b.js', 'drills/unit/c.js',
            'foo/codec/d.js', 'x/node_modules/e.js', 'actions/f.js'])
        try {
            const found = gate.walk(root, []).map(f => path.relative(root, f).split(path.sep).join('/')).sort()
            assert.deepStrictEqual(found, ['actions/f.js', 'drills/unit/c.js', 'foo/codec/d.js'])
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    })

    it('scans the nested test/drills/unit/ suites of the real tree', () => {
        const testDir = path.join(__dirname, '..', '..')
        const found = gate.walk(testDir, []).map(f => path.relative(testDir, f).split(path.sep).join('/'))
        assert.ok(found.some(f => f.startsWith('drills/unit/')), 'a nested unit/ directory must not hide live suites')
        assert.ok(!found.some(f => f.startsWith('unit/')), 'the top-level unit/ stays out of the scan')
    })
})

describe('check-stake-teardown gate: payloads assembled from a bare STAKE', () => {
    it('catches an array-join payload on one line', () => {
        assert.strictEqual(scan("let msg = ['STAKE', 1, amount, pk].join('|')").length, 1)
        assert.strictEqual(scan('let msg = [`STAKE`, version, amount].join("|")').length, 1)
    })

    it('catches an array-join payload that spans several lines, on its STAKE line', () => {
        const hits = scan(['let msg = [', "    'STAKE', '1', amount,", '    pk', "].join('|')"].join('\n'))
        assert.deepStrictEqual(hits.map(h => h.line), [2])
    })

    it('catches a STAKE held in a const the payload is built from', () => {
        const hits = scan(["const ACTION = 'STAKE'", "let msg = ACTION + '|1|' + amount"].join('\n'))
        assert.deepStrictEqual(hits.map(h => h.line), [1])
    })

    it('leaves an action key, a comparison and an UNSTAKE array alone', () => {
        assert.strictEqual(scan("submit(sdk, { action: 'STAKE', params: p })").length, 0)
        assert.strictEqual(scan("if (tx.action === 'STAKE') count++").length, 0)
        assert.strictEqual(scan("const ok = tx.action == 'STAKE';").length, 0)
        assert.strictEqual(scan("let msg = ['UNSTAKE', 1, pk].join('|')").length, 0)
    })

    it('accepts an array-join payload under a reasoned marker or booked by a registration', () => {
        assert.strictEqual(scan(['// stake-teardown-ok: zero amount, always rejected',
            "let msg = ['STAKE', 1, 0, pk].join('|')"].join('\n')).length, 0)
        assert.strictEqual(scan(["let msg = ['STAKE', 1, amount, pk].join('|')",
            'stakeTeardown.registerStake({ addressInfo: addr, signingPubkey: pk, amount: amount })'].join('\n')).length, 0)
    })
})
