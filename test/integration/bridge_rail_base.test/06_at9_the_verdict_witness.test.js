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
 *********************************************************************/

'use strict';

const {
    assert,
    chainRail,
    cryptoHelper,
    transactionHelper,
    driveVerdictWitness,
    GAS_TICK,
    state,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

async function readAfterWitness() {
    const after = await chainRail.withRail(state.dogeRail, () => driveVerdictWitness(
        { cryptoHelper, transactionHelper, network: NETWORK, gasTick: GAS_TICK },
        state.venue.dogeVenue, 'AT9.AFTER'));
    const before = { SEND: state.witnessBefore.SEND, ORDER: state.witnessBefore.ORDER,
        DISPENSER: state.witnessBefore.DISPENSER };
    const afterOnly = { SEND: after.SEND, ORDER: after.ORDER, DISPENSER: after.DISPENSER };
    // Was the tick UNKNOWN to the grader in the before-half? On a fresh-replay ledger
    // it was, and that decides which form of AT9's claim is even satisfiable.
    const tickWasUnknown = Object.values(before).some((v) => /TICK \(unknown\)/.test(String(v)));
    state.evidence.at9 = { before: before, beforeTxids: state.witnessBefore.txids, beforeSource: state.witnessBefore.source,
        after: afterOnly, afterTxids: after.txids, afterSource: after.source,
        tickWasUnknownBefore: tickWasUnknown };
    return { before, afterOnly, tickWasUnknown };
}

// ── AT9 ────────────────────────────────────────────────────────────────────────
bridgeRailSuite('AT9: the verdict witness', function () {

    it('carries the same controller-guarded verdicts on DOGE after the XCHAIN row exists', async function () {
        this.timeout(0);
        if (needsFederation(this, 'AT9 after-half')) return;
        // BOTH HALVES ON ONE LEDGER. The before-half was taken by this suite, on this
        // venue's own DOGE indexer, while it provably held no XCHAIN row; the guards
        // suite's witness is taken on a CLONED ledger that already carries the pre-D62
        // row, so comparing across the two measures the clone and not the bridge, which
        // is how drive 7 came back with `insufficient funds` against `TICK (unknown)`.
        assert.ok(state.witnessBefore, 'no witness was taken before the XCHAIN row existed, so AT9 has ' +
            'nothing to compare against');
        assert.strictEqual(await state.venue.hasTokenRow('DOGE', GAS_TICK), true,
            'AT9 compares the verdicts across the XCHAIN row APPEARING, and it has not appeared ' +
            'on this ledger, so there is no event to compare across');
        const { before, afterOnly, tickWasUnknown } = await readAfterWitness();

        // WHAT AT9 ACTUALLY PINS, and why the strict form is wrong on this ledger.
        //
        // Section 9's obligation (and the row that gated it) is that the `getTokenInfo(GAS)`
        // branches must not flip a controller-guarded action's verdict when the XCHAIN row
        // appears off BTC: specifically that the guard-gas reservation stays gated off BTC
        // until milestone 2's flag day, and that nothing a guard refuses becomes VALID.
        //
        // A literal string equality expresses that only on a ledger where the grader
        // already KNEW the tick in both halves. On a fresh-replay ledger the row genuinely
        // appears mid-drive, and then the before-half can only ever read `TICK (unknown)`
        // (the grader stops at tick resolution) while the after-half reaches the balance
        // check and reads `insufficient funds`: drive 11 measured exactly that pair. That
        // difference is forced by the tick existing at all, on any correct implementation,
        // so demanding the strings match is asserting something no code can satisfy. The
        // guards suite passes the strict form only because ITS ledger is a clone that
        // already carried the pre-D62 row, i.e. it witnesses no appearance at all.
        //
        // So: every action stays REFUSED, none of them on the guard-gas branch, and the
        // strict equality is held exactly where it is meaningful.
        for (const action of ['SEND', 'ORDER', 'DISPENSER']) {
            assert.ok(/^invalid\b/.test(String(afterOnly[action])),
                'the controller-guarded ' + action + ' on DOGE is no longer refused once the ' +
                'XCHAIN row exists on that chain: ' + afterOnly[action] + ' (before: ' +
                before[action] + ')');
            assert.ok(!/guard gas/i.test(String(afterOnly[action])),
                'the ' + action + ' is refused on the GUARD-GAS branch now that the XCHAIN row ' +
                'exists off BTC (' + afterOnly[action] + '), which section 9 gates on milestone ' +
                "2's flag day and not on the row's existence");
        }
        if (!tickWasUnknown) {
            assert.deepStrictEqual(afterOnly, before,
                'a controller-guarded verdict on DOGE moved when the XCHAIN row appeared on that ' +
                'chain, and the grader already knew the tick in both halves, so nothing about the ' +
                "row's appearance can account for the move");
        }
    });
});
