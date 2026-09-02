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

// A swallowed give-up is invisible in a green run by construction: the wait
// times out, hands back null, and the run keeps going. So the two things that
// keep it from coming back are pinned here rather than in the live tier.
//
//   requireRow     turns a null into a failure AT the wait, naming the row.
//   check-wait-swallow.js  is the gate that keeps every waitFor site under
//                  test/ on one of the loud shapes. Its own classification is
//                  tested against synthetic sources, because a scanner that
//                  quietly stopped matching would pass a clean report forever.

const assert = require('assert')
const path = require('path')

const requireRow = require('../../helpers/requireRow')
const gate = require('../../../scripts/check-wait-swallow')

// One synthetic file, scanned the way the gate scans a real one.
function findings(src, { helper = false } = {}){
    return gate.scanLines(src.split('\n'), helper ? 'test/helpers/x.js' : 'test/actions/x.test.js', helper)
}

describe('requireRow: a give-up fails at the wait', function () {
    it('returns the row unchanged when the wait landed one', function () {
        const row = { action_index: 7, status: 'valid' }
        assert.strictEqual(requireRow(row, 'anything'), row)
    })

    it('throws on null, naming what never landed', function () {
        assert.throws(
            () => requireRow(null, 'sendSendV0: SEND 5 JDOG to bc1q (tx abc) at status=valid'),
            /sendSendV0: SEND 5 JDOG to bc1q \(tx abc\) at status=valid never landed/,
        )
    })

    it('points the reader at the GAVE UP line, which says absent vs wrong status', function () {
        assert.throws(() => requireRow(undefined, 'x'), /GAVE UP line above/)
    })

    // A row is a database record: `{}` and `0` rows are not shapes this suite
    // produces, but falsiness is the whole test, so pin what counts as landed.
    it('treats any object as landed and every falsy value as a give-up', function () {
        assert.doesNotThrow(() => requireRow({}, 'x'))
        assert.throws(() => requireRow(false, 'x'), /never landed/)
        assert.throws(() => requireRow(0, 'x'), /never landed/)
    })
})

describe('check-wait-swallow: the gate that keeps helpers loud', function () {
    it('flags a helper wait whose null is stored and returned', function () {
        const hits = findings([
            "module.exports = {",
            "    async sendThing(info){",
            "        let row = await indexerDatabase.waitForSend({ status: 'valid' })",
            "        return { thing: row }",
            "    }",
            "}",
        ].join('\n'), { helper: true })
        assert.strictEqual(hits.length, 1)
        assert.strictEqual(hits[0].line, 3)
        assert.strictEqual(hits[0].helper, true)
    })

    it('accepts a wait wrapped in requireRow', function () {
        const hits = findings([
            "        let row = requireRow(await indexerDatabase.waitForSend({",
            "            status: 'valid'",
            "        }), 'sendThing: the SEND')",
        ].join('\n'), { helper: true })
        assert.deepStrictEqual(hits, [])
    })

    it('accepts an explicit if (!row) throw, even several lines later', function () {
        const hits = findings([
            "    async sendThing(info){",
            "        let row = await indexerDatabase.waitForSend({ status: 'valid' })",
            "        console.log('landed?')",
            "        if(!row)",
            "            throw new Error('sendThing: the SEND never landed')",
            "        return row",
            "    }",
        ].join('\n'), { helper: true })
        assert.deepStrictEqual(hits, [])
    })

    it('accepts an assertion naming the row', function () {
        const hits = findings([
            "        const send = await indexerDatabase.waitForSend({ status: 'valid' })",
            "        assert(send, 'the SEND should land valid')",
        ].join('\n'))
        assert.deepStrictEqual(hits, [])
    })

    it('accepts a wait handed straight back to the caller', function () {
        const hits = findings("        return await indexerDatabase.waitForOrder({ status: 'valid' })")
        assert.deepStrictEqual(hits, [])
    })

    it('accepts a marked site, on its own line or in the comment block above', function () {
        assert.deepStrictEqual(findings(
            "        await indexerDatabase.waitForBatch({ status: 'valid' }) // give-up-ok: sequencing"), [])
        assert.deepStrictEqual(findings([
            "        // give-up-ok: sequencing only; the row below is the",
            "        // assertion this case is actually about.",
            "        await indexerDatabase.waitForBatch({ status: 'valid' })",
        ].join('\n')), [])
    })

    it('does not accept a bare marker with no reason', function () {
        const hits = findings("        await indexerDatabase.waitForBatch({}) // give-up-ok:")
        assert.strictEqual(hits.length, 1)
    })

    // The guard has to belong to THIS function. A later method's `if (!row)
    // throw` reads as a guard to a naive forward scan, which would excuse
    // exactly the swallow the gate exists to catch.
    it('does not credit a guard that lives in the next method', function () {
        const hits = findings([
            "    async sendThing(info){",
            "        let row = await indexerDatabase.waitForSend({ status: 'valid' })",
            "        return { thing: row }",
            "    },",
            "    async sendOther(info){",
            "        let row = await indexerDatabase.waitForMint({ status: 'valid' })",
            "        if(!row) throw new Error('sendOther: the MINT never landed')",
            "        return row",
            "    }",
        ].join('\n'), { helper: true })
        assert.strictEqual(hits.length, 1)
        assert.strictEqual(hits[0].line, 2)
    })

    it('ignores waits that are not Database row polls', function () {
        assert.deepStrictEqual(findings([
            "        await regtestMinerConnector.waitForReady(20000, 1000)",
            "        await waitForMesh(this.mvh, { timeoutMs: 5000 })",
            "        let row = await waitForAnyDelegation({ source: a, txHash: t })",
        ].join('\n'), { helper: true }), [])
    })

    it('ignores a waitFor named only in a comment', function () {
        assert.deepStrictEqual(findings("        // indexerDatabase.waitForSend() would be wrong here"), [])
    })
})

describe('check-wait-swallow: the live tree', function () {
    // The gate is only worth its CI slot if the tree it guards is clean now;
    // a report of "42 known swallows" is a number nobody acts on.
    it('finds no swallowed give-up anywhere under test/', function () {
        const { helpers, tests } = gate.scan()
        const shown = (h) => h.file + ':' + h.line + '  ' + h.text
        assert.deepStrictEqual(helpers.map(shown), [],
            'a fixture helper must fail at the wait, not hand back a null row')
        assert.deepStrictEqual(tests.map(shown), [],
            'an in-test wait must assert on its row or say why an empty one is fine')
    })

    it('scans the helper directory it claims to guard', function () {
        // Cheap tripwire for a path or filter change that would make the gate
        // report clean because it stopped looking.
        const hits = gate.scanFile(path.join(__dirname, '../../helpers/sendHelper.js'))
        assert.deepStrictEqual(hits, [], 'sendHelper is expected clean')
        const src = require('fs').readFileSync(
            path.join(__dirname, '../../helpers/sendHelper.js'), 'utf8')
        assert.ok(/requireRow\(await indexerDatabase\.waitForSend/.test(src),
            'sendHelper should still be the wrapped shape this gate recognises')
    })
})
