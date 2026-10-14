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
 * AT5 observe gate: block freshness and node catch-up.
 ********************************************************************/

const assert = require('assert');

const { drill, GRACE_S, DEFAULTS, RUN3, RUN3_BASE_BLOCK_TIME } = require('./helpers/fixtures.js');

// classifyBlockFreshness over run 3's blocks and over a live one.
function registerFreshnessVerdictTests() {
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
}

// classifyBlockFreshness at its boundary, ahead of the clock, and blind.
function registerFreshnessEdgeTests() {
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
}

// evaluateCatchUp: a node still replaying, one at the barrier working point,
// and the boundary between them.
function registerCatchUpWorkingPointTests(settings) {
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
}

// evaluateCatchUp: a node at the tip, and a reading it could not take.
function registerCatchUpEdgeTests(settings) {
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
}

describe('AT5 barrier drill: the observe-phase gate (row 46)', function () {

    describe('classifyBlockFreshness: was this block live when the drill saw it?', function () {
        registerFreshnessVerdictTests();
        registerFreshnessEdgeTests();
    });

    describe('evaluateCatchUp: has the node stopped burning backlog?', function () {

        const settings = {
            slackBlocks: DEFAULTS.catchUpSlackBlocks,
            graceS: GRACE_S,
            toleranceS: DEFAULTS.catchUpToleranceS
        };

        registerCatchUpWorkingPointTests(settings);
        registerCatchUpEdgeTests(settings);
    });
});
