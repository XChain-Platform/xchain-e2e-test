'use strict';

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
 ********************************************************************/

const assert = require('assert');
const drive = require('../../../helpers/oracleBatchDrive');
const { WINDOW_ROUNDS, MIN_SIGNATURES, WIRE_MAX_BYTES } = require('../helpers/pairs');
const { sumStat, roundsOn } = require('../helpers/wire');

// One split wire: parses as a PRICE batch, fits the reader cap, re-anchored and co-signed.
function assertSplitWire(p, venue, signerSet) {
    assert.ok(p.ok, 'a window A wire does not parse as a PRICE batch: ' + p.reason);
    assert.strictEqual(p.roundCount, 2,
        'a window A wire carries ' + p.roundCount + ' round(s); the calibration says exactly ' +
        'two fit, so a 1-round wire means the packer under-filled and a 3-round wire means it ' +
        'over-filled past the bound it measures against');
    assert.ok(p.bodyBytes <= WIRE_MAX_BYTES,
        'a window A wire carries a ' + p.bodyBytes + '-byte inflated body, over the ' +
        WIRE_MAX_BYTES + '-byte reader cap: a DOGE fee paid on an action no indexing node ' +
        'will finish inflating');
    // Section 4: the batch header anchor IS the last included round's own anchor.
    assert.strictEqual(p.anchor, p.rounds[p.rounds.length - 1].btcBlockHeight,
        'a split wire\'s header anchor was not re-derived for its sub-range; both verifiers ' +
        'reject that wire');
    const distinct = new Set(p.sigs.map((s) => s.pubkey));
    assert.strictEqual(distinct.size, p.sigs.length, 'a window A wire carries a duplicate signer');
    assert.ok(distinct.size >= MIN_SIGNATURES,
        'SIGNING ROUND rung: a split wire carries only ' + distinct.size + ' signature(s); each ' +
        'sub-range is separately proposed and separately co-signed, so a short set means peers ' +
        'could not reproduce THAT range from their own price_snapshots' +
        drive.railDiagnosis(venue, signerSet));
}

// Registers part of the assertions inside the caller's describe.
module.exports = function registerSplit(ctx) {
    it('the overflowing window published as SPLIT batches, packed by range', function () {
        const { venue, signerSet, roundsA, pubsA, wiresA, settleA, statsAfterA } = ctx;
        assert.ok(settleA && settleA.reached,
            'no wire was ever broadcast for the overflowing window. Read the rail state: signRounds 0 ' +
            'means the leader never proposed (leader election or the window self-check); signTimeouts > 0 ' +
            'means it proposed and no quorum answered; unpublishable > 0 means the packer never found a ' +
            'range that fits, which would make the calibration wrong.' + drive.railDiagnosis(venue, signerSet));
        assert.strictEqual(pubsA.length, 2,
            'window A carried ' + WINDOW_ROUNDS + ' rounds that cannot share one wire, so the packer ' +
            'must emit exactly two; it emitted ' + pubsA.length + '. One means the overflow never ' +
            'happened (read the calibration above); more than two means the packer degenerated below ' +
            'the range the calibration says fits.' + drive.railDiagnosis(venue, signerSet));
        assert.ok(settleA.settled,
            'a third wire was still arriving when the quiet window expired, so "exactly two" is a race ' +
            'this run happened to win rather than a property.' + drive.railDiagnosis(venue, signerSet));
        assert.ok(sumStat(statsAfterA, 'batchSplitCount') >= 1,
            'two wires were emitted for one window but batchSplitCount is ' +
            sumStat(statsAfterA, 'batchSplitCount') + '; the split counter is the machine-checkable ' +
            'half of the claim and it did not move');

        for (const p of wiresA) assertSplitWire(p, venue, signerSet);

        // The split is a partition: every driven round on exactly one wire, in order,
        // with no round duplicated across wires and none dropped between them.
        assert.deepStrictEqual(roundsOn(wiresA), roundsA.map((r) => r.round),
            'the two split wires cover [' + roundsOn(wiresA).join(', ') + '] but the federation ' +
            'finalized [' + roundsA.map((r) => r.round).join(', ') + ']. A split that loses or ' +
            'duplicates a round is not a split.');
        const ranges = wiresA.map((p) => [p.firstRound, p.lastRound]).sort((a, b) => a[0] - b[0]);
        assert.ok(ranges[0][1] < ranges[1][0],
            'the split wires\' declared windows overlap ([' + ranges[0].join('..') + '] and [' +
            ranges[1].join('..') + ']); two batches claiming one round is the false-equivocation shape');
    });
};
