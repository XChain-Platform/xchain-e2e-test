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
 * The AT5 drill's observe-phase gate (spec row 46), pinned without a chain.
 *
 * WHY THIS EXISTS. The drill is a four-hour run against a live public chain, so
 * a defect in WHICH blocks it grades is found, at best, four hours after the
 * launch and, at worst, not at all: run 3 (2026-09-09) returned
 * `status: "completed"` over six blocks that had each been sitting in the
 * decoder for over an hour, scored them with `waitS: 0`, `escape: "none"` and
 * `deferralCount: 0`, and reported that as an AT5 observation. Nothing in the
 * result said the barrier had not been measured; the number that should have
 * said so, `stallsWithinGracePlusConfirm`, read 0 of 6, which is what a broken
 * barrier looks like too.
 *
 * THE NUMBERS BELOW ARE RUN 3'S OWN. The six heights (67879822-67879827) and
 * their ages on arrival (4,303-4,453 s) are the measurements the record
 * records; the block times are reconstructed so that those ages come out
 * exactly, because the ages are what the gate reasons about and the absolute
 * times are not. So this file asks the fixed drill what it would have said
 * about the run that motivated the fix, and the answer must be "nothing was
 * graded", not "six blocks cleared the barrier instantly".
 *
 * EVERY OBSERVATION RECORD HERE IS PRODUCED BY THE DRILL'S OWN `observeBlock`,
 * not hand-written to the shape the summary wants: a gate that is exported and
 * correct but never wired into the record would otherwise pass this file. The
 * database connection is a reader that finds no rows, which is the honest shape
 * for a node whose mirror is empty, and no socket is opened anywhere.
 *
 *   npx mocha --no-config test/unit/oracleBatchBarrierTestnet.observe.test.js
 ********************************************************************/

const assert = require('assert');

const drill = require('../drills/oracleBatchBarrierTestnet.drill.js');

// The frozen barrier grace the drill reasons about (xchain-indexer's
// HUB_SYNC_WATERMARK_GRACE_S.price). Restated here rather than imported so a
// silent move of the drill's copy shows up as a failure in this file too.
const GRACE_S = 4800;

// The drill's default gate settings, as readSettings hands them over with an
// empty environment. Read from the code rather than retyped, so a changed
// default cannot leave these tests measuring a value no run would use.
const DEFAULTS = drill.readSettings({});

// ---------------------------------------------------------------------------
// A node whose databases answer, and hold nothing
// ---------------------------------------------------------------------------

// Every read the observation makes goes through one connection. Returning no
// rows is exactly what run 3's node did hold (its mirror had no finalized round
// at all), so this is the real case rather than a convenient one.
function emptyConn() {
    const calls = [];
    return {
        calls: calls,
        async query(sql, params) { calls.push({ sql: sql, params: params }); return []; }
    };
}

function fakeNode() {
    return { mirrorDbName: 'AT5_Mirror', hubDbName: 'AT5_Hub', indexerDbName: 'AT5_Indexer' };
}

// Origin's price side. `action()` is never reached here because a node holding
// no rows reports no actions in the block, and asserting that is part of the
// point: nothing in this file talks to the public explorer.
function fakeOrigin() {
    return {
        async newestRoundAtOrBefore() { return { round: null, blockTimestamp: null, rowsScanned: 0 }; },
        async action() { throw new Error('origin.action must not be reached for a block with no actions'); }
    };
}

// One real deferral line, in the indexer's own wording, so the escape
// classification under test is driven by the parser the drill ships rather than
// by an object shaped like its output.
function deferralFor(height, blockTime) {
    const line = 'Deferring block ' + height + ' (price time-sync): Error: price time-sync barrier timed out ' +
        'after 900000ms waiting for block time ' + blockTime + ' (mirror max round timestamp ' +
        (blockTime - 5000) + ', stream watermark at ' + (blockTime - 100) + ')';
    const parsed = drill.parseDeferral(line);
    assert.ok(parsed, 'the drill must parse its own deferral wording');
    return parsed;
}

// One observation, built by the drill's own observeBlock.
async function observe(opts) {
    return drill.observeBlock({
        node: fakeNode(),
        conn: emptyConn(),
        origin: fakeOrigin(),
        tables: [],
        height: opts.height,
        blockTime: opts.blockTime,
        firstSeenAt: opts.firstSeenAt,
        processedAt: opts.processedAt,
        deferrals: opts.deferrals || [],
        originNow: { lag: 0, blockIndex: opts.height },
        maxBlockAgeS: opts.maxBlockAgeS === undefined ? DEFAULTS.maxBlockAgeS : opts.maxBlockAgeS
    });
}

// ---------------------------------------------------------------------------
// Run 3, as it actually happened
// ---------------------------------------------------------------------------

// Height to block age in seconds, from a real run: six consecutive heights
// 4,303-4,453 s old on arrival, with `firstSeenAt` equal to `processedAt`.
const RUN3 = [
    { height: 67879822, ageAtFirstSeenS: 4453 },
    { height: 67879823, ageAtFirstSeenS: 4423 },
    { height: 67879824, ageAtFirstSeenS: 4393 },
    { height: 67879825, ageAtFirstSeenS: 4363 },
    { height: 67879826, ageAtFirstSeenS: 4333 },
    { height: 67879827, ageAtFirstSeenS: 4303 }
];

const RUN3_BASE_BLOCK_TIME = 1_757_390_000;

async function run3Observations() {
    const out = [];
    for (let i = 0; i < RUN3.length; i++) {
        const blockTime = RUN3_BASE_BLOCK_TIME + i * 30;
        const firstSeenAt = blockTime + RUN3[i].ageAtFirstSeenS;
        out.push(await observe({
            height: RUN3[i].height,
            blockTime: blockTime,
            firstSeenAt: firstSeenAt,
            // run 3: firstSeenAt === processedAt on every one of the six.
            processedAt: firstSeenAt,
            deferrals: []
        }));
    }
    return out;
}

// A run of the same shape as the one AT5 is asking for: blocks seen seconds
// after they were mined, held at the barrier, released on the watermark once
// the grace had passed.
async function liveObservations(stalls) {
    const out = [];
    for (let i = 0; i < stalls.length; i++) {
        const blockTime = 1_757_500_000 + i * 60;
        const height = 67_900_000 + i;
        out.push(await observe({
            height: height,
            blockTime: blockTime,
            firstSeenAt: blockTime + 18,          // one poll after the decoder had it
            processedAt: blockTime + stalls[i],
            deferrals: [deferralFor(height, blockTime)]
        }));
    }
    return out;
}

// ---------------------------------------------------------------------------

describe('AT5 barrier drill: the observe-phase gate (row 46)', function () {

    describe('classifyBlockFreshness: was this block live when the drill saw it?', function () {

        it('refuses every block run 3 graded, and names them a backlog', function () {
            for (const b of RUN3) {
                const f = drill.classifyBlockFreshness({
                    blockTime: RUN3_BASE_BLOCK_TIME,
                    firstSeenAt: RUN3_BASE_BLOCK_TIME + b.ageAtFirstSeenS,
                    maxAgeS: DEFAULTS.maxBlockAgeS
                });
                assert.strictEqual(f.usable, false,
                    'height ' + b.height + ' was ' + b.ageAtFirstSeenS + 's old when first seen');
                assert.strictEqual(f.reason, 'stale-backlog');
                assert.strictEqual(f.ageAtFirstSeenS, b.ageAtFirstSeenS);
            }
        });

        it('accepts a block first seen a poll after it was mined', function () {
            const f = drill.classifyBlockFreshness({
                blockTime: 1_757_500_000, firstSeenAt: 1_757_500_018, maxAgeS: DEFAULTS.maxBlockAgeS
            });
            assert.deepStrictEqual(
                { usable: f.usable, reason: f.reason, ageAtFirstSeenS: f.ageAtFirstSeenS },
                { usable: true, reason: 'live', ageAtFirstSeenS: 18 });
        });

        it('puts the boundary exactly at maxAgeS, inclusive', function () {
            const at = drill.classifyBlockFreshness({ blockTime: 1000, firstSeenAt: 1000 + 120, maxAgeS: 120 });
            const past = drill.classifyBlockFreshness({ blockTime: 1000, firstSeenAt: 1000 + 121, maxAgeS: 120 });
            assert.strictEqual(at.usable, true, 'a block exactly at the limit is still live');
            assert.strictEqual(past.usable, false, 'one second past the limit is a backlog');
            assert.strictEqual(past.reason, 'stale-backlog');
        });

        it('separates a chain clock running ahead from a backlog', function () {
            const ahead = drill.classifyBlockFreshness({ blockTime: 10_000, firstSeenAt: 9_000, maxAgeS: 120 });
            assert.strictEqual(ahead.usable, false);
            assert.strictEqual(ahead.reason, 'block-time-ahead-of-clock');
            assert.strictEqual(ahead.ageAtFirstSeenS, -1000);
            // A header a few seconds ahead of this host is normal and must not
            // throw a block away.
            const slight = drill.classifyBlockFreshness({ blockTime: 10_000, firstSeenAt: 9_995, maxAgeS: 120 });
            assert.strictEqual(slight.usable, true);
            assert.strictEqual(slight.reason, 'live');
        });

        it('grades nothing when a reading is missing', function () {
            for (const input of [
                { blockTime: null, firstSeenAt: 1000, maxAgeS: 120 },
                { blockTime: 1000, firstSeenAt: undefined, maxAgeS: 120 },
                { blockTime: 1000, firstSeenAt: 1000, maxAgeS: null },
                {}
            ]) {
                const f = drill.classifyBlockFreshness(input);
                assert.strictEqual(f.usable, false, JSON.stringify(input));
                assert.strictEqual(f.reason, 'unknown-arrival');
                assert.strictEqual(f.ageAtFirstSeenS, null);
            }
        });
    });

    describe('evaluateCatchUp: has the node stopped burning backlog?', function () {

        const settings = {
            slackBlocks: DEFAULTS.catchUpSlackBlocks,
            graceS: GRACE_S,
            toleranceS: DEFAULTS.catchUpToleranceS
        };

        it('holds a node that is still replaying, however it is measured', function () {
            const v = drill.evaluateCatchUp(Object.assign({
                nodeHeight: 67_876_000, decoderTip: 67_879_827,
                nodeBlockTime: 1_757_270_000, nowSec: 1_757_390_000     // the block is 33 h old
            }, settings));
            assert.strictEqual(v.caughtUp, false);
            assert.strictEqual(v.reason, 'replaying-backlog');
            assert.strictEqual(v.blocksBehind, 3827);
            assert.strictEqual(v.frontierAgeS, 120_000);
        });

        it('releases a node held at the barrier working point, which is the only place this node can be', function () {
            // The measured shape at the end of run 3's replay: about 150 blocks
            // behind the tip, and the block it is working on about 4,450 s old,
            // which is the steady state the watermark escape imposes. It can never
            // be nearer the tip than this, so waiting for the tip would never end.
            const v = drill.evaluateCatchUp(Object.assign({
                nodeHeight: 67_879_677, decoderTip: 67_879_827,
                nodeBlockTime: 1_757_385_547, nowSec: 1_757_390_000
            }, settings));
            assert.strictEqual(v.caughtUp, true);
            assert.strictEqual(v.reason, 'barrier-working-point');
            assert.strictEqual(v.blocksBehind, 150);
            assert.strictEqual(v.frontierAgeS, 4453);
        });

        it('puts the working-point boundary exactly at grace + tolerance', function () {
            const base = { nodeHeight: 100, decoderTip: 1000, nowSec: 1_000_000 };
            const limit = GRACE_S + DEFAULTS.catchUpToleranceS;
            const at = drill.evaluateCatchUp(Object.assign({}, base, settings,
                { nodeBlockTime: 1_000_000 - limit }));
            const past = drill.evaluateCatchUp(Object.assign({}, base, settings,
                { nodeBlockTime: 1_000_000 - limit - 1 }));
            assert.strictEqual(at.caughtUp, true, 'exactly at the working point counts as caught up');
            assert.strictEqual(past.caughtUp, false, 'one second further back is still backlog');
            assert.strictEqual(past.reason, 'replaying-backlog');
        });

        it('releases a node that reached the tip, whatever its block times say', function () {
            // Nothing guarantees a chain-only node gets here (D61 says it will not),
            // but a node that DID must not be made to wait on the second condition.
            const v = drill.evaluateCatchUp(Object.assign({
                nodeHeight: 67_879_826, decoderTip: 67_879_827,
                nodeBlockTime: 1_000_000, nowSec: 9_000_000
            }, settings));
            assert.strictEqual(v.caughtUp, true);
            assert.strictEqual(v.reason, 'at-tip');
            assert.strictEqual(v.blocksBehind, 1);
        });

        it('concludes nothing from a reading it could not take', function () {
            const noTip = drill.evaluateCatchUp(Object.assign({
                nodeHeight: 67_879_826, decoderTip: null, nodeBlockTime: 1_757_389_000, nowSec: 1_757_390_000
            }, settings));
            assert.strictEqual(noTip.caughtUp, false);
            assert.strictEqual(noTip.reason, 'unknown');

            // A tip it can see and a block time it cannot: the tip test still runs,
            // and a node far behind stays held rather than defaulting to satisfied.
            const noBlockTime = drill.evaluateCatchUp(Object.assign({
                nodeHeight: 67_876_000, decoderTip: 67_879_827, nodeBlockTime: null, nowSec: 1_757_390_000
            }, settings));
            assert.strictEqual(noBlockTime.caughtUp, false);
            assert.strictEqual(noBlockTime.reason, 'replaying-backlog');
            assert.strictEqual(noBlockTime.frontierAgeS, null);
        });
    });

    describe('the observation record carries the gate', function () {

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
                assert.strictEqual(obs[i].escape, 'none');
                assert.strictEqual(obs[i].escapeEvidence.deferralCount, 0);
                assert.strictEqual(obs[i].stallS, RUN3[i].ageAtFirstSeenS);
            }
        });

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

        it('still contradicts a watermark escape that fired before the grace', async function () {
            const [o] = await liveObservations([GRACE_S - 1]);
            assert.strictEqual(o.usable, true, 'the block was live; the barrier is what is in question');
            assert.strictEqual(o.escape, 'watermark');
            assert.strictEqual(o.escapeEvidence.corroborated, false);
        });
    });

    describe('summarize: a backlog can never read as a measured barrier', function () {

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
            assert.deepStrictEqual(s.escapes, { none: 6 });
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
    });

    describe('usableObservations', function () {

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
    });

    describe('the gate settings the launcher can move', function () {

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
    });
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
