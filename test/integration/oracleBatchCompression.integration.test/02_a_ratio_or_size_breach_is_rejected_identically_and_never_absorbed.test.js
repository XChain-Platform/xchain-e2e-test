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
const { priceBatch, REASON_SIZE, REASON_RATIO } = require('./helpers/constants');

function registerCase1(S) {
    it('a SIZE-cap breach is rejected with the identical status on both nodes', function () {
        const txid = S.breachSize.landed.txid;
        assert.strictEqual(S.breachSize.reason, REASON_SIZE);
        const live = S.liveRows[txid], replay = S.replayRows[txid];
        assert.ok(live && replay, 'one of the two nodes wrote no prices row for the size-cap breach');
        assert.strictEqual(live.status, S.breachSize.status,
            'the live node recorded "' + live.status + '" for a payload whose inflated body is ' +
            S.breachSize.inflatedBody.length + ' B, past the ' + priceBatch.PRICE_WIRE_MAX_BYTES +
            ' B reader bound. Expected "' + S.breachSize.status + '".');
        assert.strictEqual(replay.status, live.status,
            'the two nodes disagree about a size-cap breach: live "' + live.status + '" vs replay "' +
            replay.status + '". Section 4a makes this bound CONSENSUS precisely so they cannot.');
        assert.strictEqual(live.validation_status, 'invalid');
        assert.strictEqual(replay.validation_status, 'invalid');
    });
}

function registerCase2(S) {
    it('a RATIO-cap breach is rejected with the identical status on both nodes', function () {
        const txid = S.breachRatio.landed.txid;
        assert.strictEqual(S.breachRatio.reason, REASON_RATIO);
        // Which of the two caps binds is `ratioCap <= PRICE_WIRE_MAX_BYTES`, resolved
        // on the DECODED length, so re-derive it here rather than trusting the
        // reason string: a ratio breach that is really size-bound would still be
        // rejected, and this clause would then be the size clause a second time.
        const rawBytes = priceBatch.decodeCanonicalBase64(S.breachRatio.field);
        assert.notStrictEqual(rawBytes, null, 'the crafted ratio breach is not canonical base64');
        assert.ok(rawBytes.length * priceBatch.PRICE_BATCH_MAX_INFLATE_RATIO <= priceBatch.PRICE_WIRE_MAX_BYTES,
            'the crafted breach is SIZE-bound, not ratio-bound: ' + rawBytes.length + ' compressed bytes ' +
            'times ' + priceBatch.PRICE_BATCH_MAX_INFLATE_RATIO + ' is above the ' +
            priceBatch.PRICE_WIRE_MAX_BYTES + ' B cap, so the size bound would bind first');
        const live = S.liveRows[txid], replay = S.replayRows[txid];
        assert.ok(live && replay, 'one of the two nodes wrote no prices row for the ratio-cap breach');
        assert.strictEqual(live.status, S.breachRatio.status,
            'the live node recorded "' + live.status + '" for a ' + S.breachRatio.field.length +
            ' byte field that inflates to ' + S.breachRatio.inflatedBody.length + ' B, a ratio far past ' +
            priceBatch.PRICE_BATCH_MAX_INFLATE_RATIO + ':1. Expected "' + S.breachRatio.status + '".');
        assert.strictEqual(replay.status, live.status,
            'the two nodes disagree about a ratio-cap breach: live "' + live.status + '" vs replay "' +
            replay.status + '"');
        assert.strictEqual(live.validation_status, 'invalid');
        assert.strictEqual(replay.validation_status, 'invalid');
    });
}

function registerCase3(S) {
    it('nothing from a breached wire is absorbed: no structural fields, no snapshots, on either node', function () {
        // A wire refused at decompression must never record structure. `parseV0`
        // reaches its storage step with `firstRound` undefined and `roundsWire`
        // empty, so a batch column carrying anything here means a node parsed a
        // body it had already refused to inflate.
        for (const b of [S.breachSize, S.breachRatio]) {
            for (const [label, rows] of [['live', S.liveRows], ['replay', S.replayRows]]) {
                const row = rows[b.landed.txid];
                assert.strictEqual(row.rounds_json, null,
                    'the ' + label + ' node stored rounds_json for a ' + b.reason +
                    ' wire it never inflated: ' + String(row.rounds_json).slice(0, 120));
                assert.strictEqual(row.sigs_json, null,
                    'the ' + label + ' node stored a signature set for a ' + b.reason + ' wire');
                assert.ok(row.round_count === null || Number(row.round_count) === 0,
                    'the ' + label + ' node stored round_count ' + row.round_count + ' for a ' +
                    b.reason + ' wire');
            }
        }

        // And the rounds those wires CLAIMED are in no table on either node. This
        // is the half that makes "never absorbed" evidence: the ghost rounds exist
        // nowhere else in this run, so finding one would name the node that
        // relaxed a bound.
        assert.deepStrictEqual(S.liveGhostSnaps, [],
            'the live node\'s hub holds ' + S.liveGhostSnaps.length + ' price_snapshots row(s) for rounds ' +
            S.ghost.first + '..' + S.ghost.last + ', which no federation ever finalized');
        assert.deepStrictEqual(S.replayGhostSnaps, [],
            'the replay node\'s hub holds ' + S.replayGhostSnaps.length + ' ghost price_snapshots row(s)');
        assert.deepStrictEqual(S.replayGhostMirror, [],
            'the replay node\'s mirror carried ' + S.replayGhostMirror.length + ' ghost row(s) back down');
        assert.deepStrictEqual(S.liveGhostActions, [],
            'the live node recorded ' + S.liveGhostActions.length + ' prices row(s) claiming a ghost round');
    });
}

module.exports = function register(S) {
    // -----------------------------------------------------------------------
    // Clause 2: a ratio/size breach, rejected identically on two nodes,
    //           and never absorbed
    // -----------------------------------------------------------------------
    registerCase1(S);
    registerCase2(S);
    registerCase3(S);
};
