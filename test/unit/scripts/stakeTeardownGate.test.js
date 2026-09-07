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
