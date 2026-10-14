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
const drive = require('../../helpers/oracleBatchDrive');
const {
    WINDOW_ROUNDS, VALIDATORS, MIN_SIGNATURES, WIRE_MAX_BYTES, KNOWN_CAPABILITY_GAP_STATUS,
} = require('./helpers/pairs');
const { sumStat, roundsOn } = require('./helpers/wire');

// Registers the calibration, consensus, split and landing assertions inside the
// caller's describe, reading what its before() put on ctx.
module.exports = function registerSplitParts(ctx) {
    it('the overflow premise is the publisher\'s OWN bound, measured not assumed', function () {
        const { venue, calib } = ctx;
        assert.ok(calib, 'the calibration never ran; the venue did not come up');
        // The overflow is filler ON TOP OF the real feed, not instead of it: if the
        // canonical set ever stopped reaching the venue, every round here would be
        // synthetic and the drill would quietly stop resembling a real window.
        assert.ok(calib.realPairs >= 30,
            'only ' + calib.realPairs + ' canonical pair(s) reached the venue, so these rounds are ' +
            'almost entirely synthetic; the federation prices 36 and this drill holds out 2');
        assert.ok(calib.pairsMid === null || calib.pairsMid > calib.realPairs,
            'the calibrated pair count (' + calib.pairsMid + ') does not exceed the canonical set (' +
            calib.realPairs + '), so no overflow filler was needed and the premise is untested');
        assert.ok(calib.pairsMid !== null,
            'no pair count satisfies "2 rounds fit AND 3 rounds do not" anywhere in 4..900 pairs. ' +
            'The largest pair count where 2 rounds fit is ' + calib.hiTwo + ' and the smallest where ' +
            '3 rounds do not is ' + calib.loThree + '. AT3 is unforceable on this wire bound, which ' +
            'means the bound moved, not that the rail broke.');
        assert.strictEqual(calib.mid2.fits, true,
            'two ' + calib.pairsMid + '-pair rounds do not fit one wire (body ' + calib.mid2.bodyBytes +
            'B, wire ' + calib.mid2.wireBytes + 'B); window A would then split one-round-per-wire and ' +
            'prove nothing about range packing');
        assert.strictEqual(calib.mid3.fits, false,
            'three ' + calib.pairsMid + '-pair rounds DO fit one wire (body ' + calib.mid3.bodyBytes +
            'B); window A would publish a single wire and there would be no split to observe');
        assert.strictEqual(calib.big1.fits, false,
            'one ' + calib.pairsBig + '-pair round fits a wire on its own (body ' + calib.big1.bodyBytes +
            'B, wire ' + calib.big1.wireBytes + 'B); there is no ceiling case to reach');
        // The interesting half of section 8, asserted rather than asserted-about: the
        // oversized round's EMITTED wire is comfortably legal and its INFLATED body is
        // not, so what refuses it is the reader's cap. Compression buys fee, not capacity.
        assert.ok(calib.big1.bodyBytes > WIRE_MAX_BYTES,
            'the oversized round\'s uncompressed body is ' + calib.big1.bodyBytes + 'B, which is not ' +
            'over the ' + WIRE_MAX_BYTES + 'B reader cap; the ceiling would then be a compression ' +
            'artifact rather than a capacity fact');
    });

    it('all eight rounds finalized on a real multi-signature quorum', function () {
        const { venue, signerSet, roundsA, roundsB } = ctx;
        const all = roundsA.concat(roundsB);
        assert.strictEqual(all.length, WINDOW_ROUNDS * 2,
            'expected ' + (WINDOW_ROUNDS * 2) + ' finalized rounds, got ' + all.length);
        for (const r of all) {
            const distinct = new Set(r.signatures.map((s) => String(s.pubkey).toLowerCase()));
            assert.ok(distinct.size >= MIN_SIGNATURES,
                'CONSENSUS rung: round ' + r.round + ' finalized on only ' + distinct.size +
                ' distinct signer(s); a weighted quorum over ' + VALIDATORS + ' equal sources needs ' +
                MIN_SIGNATURES + '. Nothing downstream of this can be read.' +
                drive.railDiagnosis(venue, signerSet));
        }
    });

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

        for (const p of wiresA) {
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

    it('every split wire LANDED: mined, parsed and stored by the landing chain', function () {
        const { venue, signerSet, landedA, notes } = ctx;
        assert.strictEqual(landedA.length, 2, 'window A produced ' + landedA.length + ' publications');
        for (const l of landedA) {
            assert.ok(/^[0-9a-f]{64}$/.test(String(l.pub.txid)),
                'PUSH rung: the publish returned ' + l.pub.txid + ' rather than a transaction id');
            assert.ok(l.block && Number.isFinite(Number(l.block.height)),
                'PUSH rung: transaction ' + l.pub.txid + ' is not in a block on the ' + venue.rail.code +
                ' node, so "they all land" is unproven for it. ' + notes.join(' | '));
            assert.ok(l.indexed,
                'PARSE rung: the ' + venue.rail.code + ' indexer wrote no prices row for ' + l.pub.txid);
            assert.strictEqual(Number(l.indexed.version), 0,
                'PARSE rung: the indexer recorded PRICE version ' + l.indexed.version + ' for a batch wire');
            assert.strictEqual(Number(l.indexed.batch_first_round), l.parsed.firstRound,
                'PARSE rung: the indexer stored batch_first_round ' + l.indexed.batch_first_round +
                ' for a wire whose FIRST_ROUND is ' + l.parsed.firstRound);
            assert.strictEqual(Number(l.indexed.batch_last_round), l.parsed.lastRound);
            assert.strictEqual(Number(l.indexed.round_count), l.parsed.roundCount,
                'PARSE rung: the indexer stored round_count ' + l.indexed.round_count + ' for a ' +
                l.parsed.roundCount + '-round batch');
            assert.strictEqual(Number(l.indexed.round_number), l.parsed.firstRound,
                'D21: a batch row carries FIRST_ROUND in round_number');
            const stored = JSON.parse(l.indexed.rounds_json || '[]');
            assert.strictEqual(stored.length, l.parsed.roundCount,
                'PARSE rung: rounds_json holds ' + stored.length + ' round(s), not ' + l.parsed.roundCount);
            // A split wire must not be silently downgraded to some other failure: the
            // only two verdicts a well-formed batch may record here are "valid" and the
            // known off-BTC capability status.
            const status = String(l.indexed.status);
            assert.ok(status === 'valid' || status === KNOWN_CAPABILITY_GAP_STATUS,
                'SIGNER RESOLUTION rung: a split wire indexed as "' + status + '". Expected either ' +
                '"valid" or the known capability-gap status "' + KNOWN_CAPABILITY_GAP_STATUS + '". ' +
                'Anything else is a parse, fee or wire regression, not the known gap.' +
                drive.railDiagnosis(venue, signerSet));
        }
    });
};
