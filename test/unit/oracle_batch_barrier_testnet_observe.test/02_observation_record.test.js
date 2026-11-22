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
 **********************************************************************
 * AT5 observe gate: the observation record the drill writes.
 ********************************************************************/

const assert = require('assert');

const { GRACE_S, DEFAULTS, RUN3, run3Observations, liveObservations } = require('./helpers/fixtures.js');

// The observation record for run 3's own blocks.
function registerObservationRecordRun3Tests() {
    it('marks run 3\'s blocks unusable, on the record the drill actually writes', async function () {
        const obs = await run3Observations();
        assert.strictEqual(obs.length, 6);
        for (let i = 0; i < obs.length; i++) {
            assert.strictEqual(obs[i].usable, false, 'height ' + obs[i].height);
            assert.strictEqual(obs[i].unusableReason, 'stale-backlog');
            assert.strictEqual(obs[i].ageAtFirstSeenS, RUN3[i].ageAtFirstSeenS);
            // The record run 3 wrote, reproduced: no wait, no deferral, and a
            // "stall" that is only the block's age.
            assert.strictEqual(obs[i].waitS, 0);
            // Run 3 recorded `escape: "none"` here. Since row 56 there is no
            // such value: nothing sampled the barrier for these blocks, so the
            // record says UNKNOWN and carries the reason. Reading an
            // unattributed block as an instant pass is what left TA5's
            // "never before the barrier permits" half unmeasured.
            assert.strictEqual(obs[i].escape, 'unknown');
            assert.ok(/never sampled/.test(obs[i].escapeEvidence.reason),
                obs[i].escapeEvidence.reason);
            assert.strictEqual(obs[i].escapeEvidence.beforePermission, 'unknown');
            // The superseded log-scraping reading is kept beside it, so run
            // 3's own numbers stay reproducible.
            assert.strictEqual(obs[i].escapeEvidence.deferralLineReading, 'none');
            assert.strictEqual(obs[i].escapeEvidence.deferralCount, 0);
            assert.strictEqual(obs[i].stallS, RUN3[i].ageAtFirstSeenS);
        }
    });
}

// The observation record for a live block the barrier held.
function registerObservationRecordLiveTests() {
    it('marks a live block usable and keeps every measurement it already carried', async function () {
        const [o] = await liveObservations([GRACE_S + 30]);
        assert.strictEqual(o.usable, true);
        assert.strictEqual(o.unusableReason, null);
        assert.strictEqual(o.ageAtFirstSeenS, 18);
        assert.strictEqual(o.maxBlockAgeS, DEFAULTS.maxBlockAgeS);
        // Nothing the record carried before the gate was added may have been
        // dropped or weakened by it.
        assert.strictEqual(o.stallS, GRACE_S + 30);
        assert.strictEqual(o.waitS, GRACE_S + 12);
        assert.strictEqual(o.escape, 'watermark');
        // Attributed from a sampled crossing now, not inferred from the
        // absence of a content round: the record names when the barrier was
        // first seen open and when it was last seen closed (row 56).
        assert.strictEqual(o.escapeEvidence.beforePermission, 'no');
        assert.ok(o.escapeEvidence.permittedAt, 'the crossing must be named');
        assert.ok(o.escapeEvidence.lastClosedAt, 'the last closed reading must be named');
        assert.strictEqual(o.escapeEvidence.corroborated, true);
        assert.strictEqual(o.escapeEvidence.graceS, GRACE_S);
        assert.strictEqual(o.escapeEvidence.deferralCount, 1);
        assert.ok(o.escapeEvidence.firstDeferral && o.escapeEvidence.firstDeferral.height === o.height);
        assert.strictEqual(o.mirrorNewestRound, null);
        assert.strictEqual(o.hubNewestRound, null);
        assert.strictEqual(o.originNewestRound, null);
        assert.ok(o.holes && o.holes.missingFromHub && o.holes.missingFromMirror);
        assert.deepStrictEqual(o.actions, []);
        assert.strictEqual(o.verdictAgreements, 0);
        assert.deepStrictEqual(o.verdictDisagreements, []);
    });
}

// The observation record's escape attribution: early and unsampled.
function registerObservationRecordEscapeTests() {
    it('still contradicts a watermark escape that fired before the grace', async function () {
        // A hub whose stream watermark is already past blockTime + grace while
        // barely any wall time has passed: the escape is genuinely OBSERVED
        // open, so it is reported, and the stall that is too short to justify
        // it is reported beside it rather than asserted away.
        const [o] = await liveObservations([GRACE_S - 1], {
            barrierSamples: (blockTime, firstSeenAt) => [{
                at: firstSeenAt, source: 'status', bootstrapped: true,
                priceSyncMaxTimestamp: blockTime - 5000,
                streamWatermark: blockTime + GRACE_S
            }]
        });
        assert.strictEqual(o.usable, true, 'the block was live; the barrier is what is in question');
        assert.strictEqual(o.escape, 'watermark');
        assert.strictEqual(o.escapeEvidence.corroborated, false);
    });

    it('records an unattributed block as unknown WITH its reason, never as a pass', async function () {
        // The same live block, with the barrier never sampled: the honest
        // answer is that nobody knows which escape opened it.
        const [o] = await liveObservations([GRACE_S + 30], { barrierSamples: () => [] });
        assert.strictEqual(o.usable, true);
        assert.strictEqual(o.escape, 'unknown');
        assert.ok(o.escapeEvidence.reason && o.escapeEvidence.reason.length > 0);
        assert.strictEqual(o.escapeEvidence.permittedAt, null);
        // And the reading it replaces is still there to compare against: the
        // old code would have called this one 'watermark' on no evidence.
        assert.strictEqual(o.escapeEvidence.deferralLineReading, 'watermark');
    });
}

describe('AT5 barrier drill: the observe-phase gate (row 46)', function () {

    describe('the observation record carries the gate', function () {
        registerObservationRecordRun3Tests();
        registerObservationRecordLiveTests();
        registerObservationRecordEscapeTests();
    });
});
