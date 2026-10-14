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
 * AT5 observe gate: summarize, usableObservations, settings, comparedVerdicts.
 ********************************************************************/

const assert = require('assert');

const { drill, GRACE_S, DEFAULTS, observe, run3Observations, liveObservations } = require('./helpers/fixtures.js');

// summarize over run 3 and over a run whose blocks arrived live.
function registerSummarizeGradingTests() {
    it('says the barrier was NOT measured for run 3, and says why', async function () {
        const s = drill.summarize({ observations: await run3Observations(), originLagSeries: [] });
        assert.strictEqual(s.barrierMeasured, false);
        assert.strictEqual(s.blocksGraded, 0);
        assert.strictEqual(s.blocksUnusable, 6);
        assert.deepStrictEqual(s.unusableReasons, { 'stale-backlog': 6 });
        assert.strictEqual(s.maxAgeAtFirstSeenS, 4453);
        assert.strictEqual(s.gradedStallsWithinGracePlusConfirm, 0);
        assert.strictEqual(s.gradedMaxStallS, null);
        assert.deepStrictEqual(s.gradedEscapes, {});
        // The clauses the run already carried are untouched: run 3's own six
        // observations, its own escape histogram, its own 0-of-6 bound count.
        assert.strictEqual(s.blocksObserved, 6);
        // 'unknown' where run 3 wrote 'none' (row 56): nothing sampled the
        // barrier, so nothing is attributed, and the histogram says so.
        assert.deepStrictEqual(s.escapes, { unknown: 6 });
        assert.strictEqual(s.stallsWithinGracePlusConfirm, 0);
        assert.strictEqual(s.maxStallS, 4453);
        assert.strictEqual(s.minStallS, 4303);
        assert.strictEqual(s.verdictsCompared, 0);
        assert.strictEqual(s.holesTotal, 0);
    });

    it('scores a run whose blocks did arrive live', async function () {
        const obs = await liveObservations([GRACE_S + 5, GRACE_S + 40, GRACE_S + 12]);
        const s = drill.summarize({ observations: obs, originLagSeries: [] });
        assert.strictEqual(s.barrierMeasured, true);
        assert.strictEqual(s.blocksGraded, 3);
        assert.strictEqual(s.blocksUnusable, 0);
        assert.strictEqual(s.gradedStallsWithinGracePlusConfirm, 3);
        assert.strictEqual(s.gradedMinStallS, GRACE_S + 5);
        assert.strictEqual(s.gradedMaxStallS, GRACE_S + 40);
        assert.deepStrictEqual(s.gradedEscapes, { watermark: 3 });
        assert.strictEqual(s.maxAgeAtFirstSeenS, 18);
        // Row 56's own numbers: every graded block was attributed, none was
        // seen processed before the barrier permitted it.
        assert.strictEqual(s.gradedEscapesAttributed, 3);
        assert.strictEqual(s.gradedEscapesUnattributed, 0);
        assert.strictEqual(s.escapeAttributionMeasured, true);
        assert.strictEqual(s.gradedProcessedBeforePermission, 0);
        assert.strictEqual(s.gradedEscapesUncorroborated, 0);
        assert.strictEqual(s.gradedBarrierApplied, 3);
        assert.strictEqual(s.gradedBarrierNotApplicable, 0);
    });
}

// summarize over transaction-free, unattributed and early-released blocks.
function registerSummarizeEscapeTests() {
    it('does not score a transaction-free block as an escape either way', async function () {
        // The barrier is never entered for a block with no transaction, so it
        // can carry no escape and cannot break the TA5 bound. On this chain
        // those are nearly all the blocks, so counting them either way would
        // bury the handful the barrier really held.
        const obs = await liveObservations([GRACE_S + 5, GRACE_S + 40],
            { blockTransactionCount: 0 });
        const s = drill.summarize({ observations: obs, originLagSeries: [] });
        assert.strictEqual(s.blocksGraded, 2);
        assert.deepStrictEqual(s.gradedEscapes, { 'not-applicable': 2 });
        assert.strictEqual(s.gradedBarrierApplied, 0);
        assert.strictEqual(s.gradedBarrierNotApplicable, 2);
        assert.strictEqual(s.gradedEscapesAttributed, 0);
        assert.strictEqual(s.gradedEscapesUnattributed, 0);
        assert.strictEqual(s.gradedProcessedBeforePermission, 0);
        assert.strictEqual(s.escapeAttributionMeasured, false,
            'a run that only ever saw empty blocks has measured no escape');
    });

    it('refuses to call the escape half measured when nothing was attributed', async function () {
        // Three live blocks, graded on every other axis, with the barrier
        // never sampled. The stall numbers still read fine; the escape half
        // must NOT, which is the difference run 5 could not express.
        const obs = await liveObservations([GRACE_S + 5, GRACE_S + 40, GRACE_S + 12],
            { barrierSamples: () => [] });
        const s = drill.summarize({ observations: obs, originLagSeries: [] });
        assert.strictEqual(s.barrierMeasured, true, 'the blocks did arrive live');
        assert.strictEqual(s.gradedStallsWithinGracePlusConfirm, 3);
        assert.strictEqual(s.escapeAttributionMeasured, false,
            'no escape was attributed, so the escape half was not measured');
        assert.strictEqual(s.gradedEscapesAttributed, 0);
        assert.strictEqual(s.gradedEscapesUnattributed, 3);
        assert.deepStrictEqual(s.gradedEscapes, { unknown: 3 });
    });

    it('keeps the bound a REAL check on the blocks it does grade', async function () {
        // One graded block leaves the barrier before the grace has passed. That
        // is the failure the bound exists to catch, and the gate must not hide
        // it by counting only the blocks that behaved.
        const obs = await liveObservations([GRACE_S + 20, GRACE_S - 600, GRACE_S + 9]);
        const s = drill.summarize({ observations: obs, originLagSeries: [] });
        assert.strictEqual(s.blocksGraded, 3);
        assert.strictEqual(s.gradedStallsWithinGracePlusConfirm, 2,
            'the early release must still be visible as a shortfall against the graded count');
        assert.strictEqual(s.gradedMinStallS, GRACE_S - 600);
    });
}

// summarize over a stale block, and the catch-up evidence it carries.
function registerSummarizeStaleAndCatchUpTests() {
    it('never counts a stale block towards the bound, even when its age exceeds the grace', async function () {
        // The trap the gate closes: a block old enough that its AGE alone
        // clears the grace would have scored as a satisfied barrier wait.
        const stale = await observe({
            height: 67_879_900,
            blockTime: 1_757_390_000,
            firstSeenAt: 1_757_390_000 + 9000,
            processedAt: 1_757_390_000 + 9000
        });
        const s = drill.summarize({ observations: [stale], originLagSeries: [] });
        assert.strictEqual(stale.stallS, 9000, 'the raw stall does clear the grace');
        assert.strictEqual(s.stallsWithinGracePlusConfirm, 1, 'and the ungraded count still sees it');
        assert.strictEqual(s.barrierMeasured, false, 'but nothing was graded');
        assert.strictEqual(s.gradedStallsWithinGracePlusConfirm, 0,
            'so it must not be counted as a barrier wait');
        assert.deepStrictEqual(s.unusableReasons, { 'stale-backlog': 1 });
    });

    it('carries the catch-up evidence through to the summary', function () {
        const s = drill.summarize({
            observations: [],
            originLagSeries: [],
            catchUp: { reason: 'barrier-working-point', durationS: 640 },
            observe: { backlogSkipped: 150 }
        });
        assert.strictEqual(s.caughtUpBy, 'barrier-working-point');
        assert.strictEqual(s.catchUpS, 640);
        assert.strictEqual(s.backlogSkipped, 150);
        assert.strictEqual(s.barrierMeasured, false);
    });
}

// usableObservations: only what the gate passed is graded.
function registerUsableObservationsTests() {
    it('counts only the records the gate passed', async function () {
        const mixed = (await run3Observations()).concat(await liveObservations([GRACE_S + 3, GRACE_S + 7]));
        const graded = drill.usableObservations(mixed);
        assert.strictEqual(mixed.length, 8);
        assert.strictEqual(graded.length, 2);
        assert.ok(graded.every((o) => o.usable === true));
    });

    it('treats anything that is not explicitly usable as ungraded', function () {
        // The observe loop's stopping condition runs on this, so a record
        // missing the field must hold the run open rather than end it.
        assert.strictEqual(drill.usableObservations([{}, { usable: 'yes' }, null, { usable: 1 }]).length, 0);
        assert.strictEqual(drill.usableObservations(null).length, 0);
    });
}

// The gate settings the launcher can move.
function registerGateSettingsTests() {
    it('defaults to values a run can reason about, and takes an override', function () {
        assert.strictEqual(DEFAULTS.maxBlockAgeS, 120);
        assert.strictEqual(DEFAULTS.catchUpSlackBlocks, 2);
        assert.strictEqual(DEFAULTS.catchUpToleranceS, 600);
        const moved = drill.readSettings({
            AT5_MAX_BLOCK_AGE_S: '45', AT5_CATCHUP_SLACK_BLOCKS: '4', AT5_CATCHUP_TOLERANCE_S: '900'
        });
        assert.strictEqual(moved.maxBlockAgeS, 45);
        assert.strictEqual(moved.catchUpSlackBlocks, 4);
        assert.strictEqual(moved.catchUpToleranceS, 900);
        // A nonsense value takes the default rather than disabling the gate.
        const junk = drill.readSettings({ AT5_MAX_BLOCK_AGE_S: 'soon' });
        assert.strictEqual(junk.maxBlockAgeS, 120);
    });
}

describe('AT5 barrier drill: the observe-phase gate (row 46)', function () {

    describe('summarize: a backlog can never read as a measured barrier', function () {
        registerSummarizeGradingTests();
        registerSummarizeEscapeTests();
        registerSummarizeStaleAndCatchUpTests();
    });

    describe('usableObservations', registerUsableObservationsTests);

    describe('the gate settings the launcher can move', registerGateSettingsTests);
});

describe('comparedVerdicts: the parity clause counts comparisons, not blocks', () => {

    const graded = (actions) => ({ usable: true, actions });
    const stale  = (actions) => ({ usable: false, actions });
    const aligned   = { coordinateAligned: true,  agree: true };
    const unaligned = { coordinateAligned: false, agree: false };

    it('counts nothing when graded blocks carry no actions, which is run 4', () => {
        const obs = [graded([]), graded([]), graded([]), graded([]), graded([]), graded([])];
        assert.strictEqual(drill.usableObservations(obs).length, 6);
        assert.strictEqual(drill.comparedVerdicts(obs), 0,
            'six graded blocks with no actions must compare nothing, or the clause is vacuous');
    });

    it('counts only comparisons that actually aligned against origin', () => {
        const obs = [graded([aligned, unaligned]), graded([aligned])];
        assert.strictEqual(drill.comparedVerdicts(obs), 2);
    });

    it('ignores actions in blocks that were never graded', () => {
        const obs = [stale([aligned, aligned]), graded([aligned])];
        assert.strictEqual(drill.comparedVerdicts(obs), 1,
            'a stale block is not evidence, so its verdicts are not comparisons either');
    });

    it('is zero for an empty run rather than throwing', () => {
        assert.strictEqual(drill.comparedVerdicts([]), 0);
    });
});
