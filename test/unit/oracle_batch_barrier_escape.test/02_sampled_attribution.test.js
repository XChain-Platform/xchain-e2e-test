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
 **********************************************************************
 * Part of test/unit/oracle_batch_barrier_escape.test.js
 ********************************************************************/

const assert = require('assert');
const { drill, B, GRACE_S, statusSeries } = require('./helpers/fixtures.js');

function registerSampledAttribution() {
    // The drill polls /status every POLL_MS; this is that series across the
    // instant run 5's block was released, at the watermark rate both of its
    // real deferral readings measured.
    const SERIES = statusSeries(1788987133, B.processedAt, 15);

registerSampledEscapes(SERIES);
registerSampledAmbiguities(SERIES);
}

function registerSampledEscapes(SERIES) {
    it('names the watermark escape and when the barrier opened', function () {
        const a = drill.attributeEscape({
            blockTime: B.barrierBlockTime, processedAt: B.processedAt,
            samples: SERIES, graceS: GRACE_S, sampleIntervalS: 15
        });
        assert.strictEqual(a.escape, 'watermark');
        assert.strictEqual(a.beforePermission, 'no');
        // The barrier opens when the watermark reaches blockTime + grace.
        const opensAt = B.barrierBlockTime + GRACE_S;
        assert.ok(a.permittedAt >= opensAt, 'permittedAt ' + a.permittedAt + ' < ' + opensAt);
        assert.ok(a.permittedAt - opensAt <= 15, 'permittedAt must be inside one sample interval');
        assert.ok(a.lastClosedAt !== null && a.lastClosedAt < opensAt,
            'the last closed reading must precede the crossing');
        assert.strictEqual(a.permittedAtIsUpperBound, true);
        assert.strictEqual(a.openedBeforeFirstSample, false);
        // The stall against the barrier's own clock clears the grace, which
        // is the corroboration the raw stamp could never give: run 5 reported
        // 4,607 s against a 4,800 s grace for this same block.
        assert.strictEqual(a.corroborated, true);
        assert.strictEqual(B.processedAt - B.barrierBlockTime, 4813);
        assert.strictEqual(B.processedAt - B.rawBlockTime, 4607);
    });

    it('reports the content escape when the mirror is what opened it', function () {
        // Same window, but the mirror takes a finalized round at or past the
        // block's time before the watermark ever gets there. D61 says a
        // chain-only node cannot reach this at the tip, so the attribution
        // must be able to SAY so rather than assume it away.
        const series = SERIES.map((s) => Object.assign({}, s, {
            streamWatermark: 0,
            priceSyncMaxTimestamp: s.at >= 1788987193 ? B.barrierBlockTime : 1788982085
        }));
        const a = drill.attributeEscape({
            blockTime: B.barrierBlockTime, processedAt: B.processedAt,
            samples: series, graceS: GRACE_S, sampleIntervalS: 15
        });
        assert.strictEqual(a.escape, 'content');
        assert.strictEqual(a.permittedAt, 1788987193);
        // The content escape has no grace to clear, so a short stall does not
        // contradict it the way it would contradict a watermark escape.
        assert.strictEqual(a.corroborated, true);
    });
}

function registerSampledAmbiguities(SERIES) {
    it('says `both` rather than picking one when the sampling cannot separate them', function () {
        // The mirror takes the round in the SAME poll in which the watermark
        // crosses (1788987328, the first sample whose watermark reaches
        // barrierBlockTime + grace), so the grid genuinely cannot order them.
        const series = SERIES.map((s) => Object.assign({}, s, {
            priceSyncMaxTimestamp: s.at >= 1788987328 ? B.barrierBlockTime : 1788982085
        }));
        const a = drill.attributeEscape({
            blockTime: B.barrierBlockTime, processedAt: B.processedAt,
            samples: series, graceS: GRACE_S, sampleIntervalS: 15
        });
        assert.strictEqual(a.escape, 'both');
        assert.ok(/both/.test(a.reason) || a.escape === 'both');
    });

    it('contradicts a watermark escape whose stall is shorter than the grace', function () {
        // The watermark cannot legally open before the grace has elapsed
        // against the block's own time. A sample that says otherwise is
        // recorded and flagged, not asserted away.
        const early = [{ at: B.barrierBlockTime + 10, source: 'status', bootstrapped: true,
                         priceSyncMaxTimestamp: 0, streamWatermark: B.barrierBlockTime + GRACE_S }];
        const a = drill.attributeEscape({
            blockTime: B.barrierBlockTime, processedAt: B.barrierBlockTime + 20,
            samples: early, graceS: GRACE_S, sampleIntervalS: 15
        });
        assert.strictEqual(a.escape, 'watermark');
        assert.strictEqual(a.corroborated, false);
    });
}

function registerBeforePermission() {
    const SERIES = statusSeries(1788987133, B.processedAt + 60, 15);

registerPermissionVerdicts(SERIES);
registerPermissionClockChecks(SERIES);
}

function registerPermissionVerdicts(SERIES) {
    it('is `no` for a block the samples saw permitted first', function () {
        const a = drill.attributeEscape({
            blockTime: B.barrierBlockTime, processedAt: B.processedAt,
            samples: SERIES, graceS: GRACE_S, sampleIntervalS: 15
        });
        assert.strictEqual(a.beforePermission, 'no');
    });

    it('is only claimed against a sample taken AFTER the block was seen processed', function () {
        // The barrier still closed for this block at a sample taken after the
        // node was already seen past its height: the node cannot have been
        // permitted, so this is the reading that proves a violation.
        const stillClosed = SERIES
            .filter((s) => s.at <= B.processedAt + 60)
            .map((s) => Object.assign({}, s, { streamWatermark: 1788982085, priceSyncMaxTimestamp: 0 }));
        const a = drill.attributeEscape({
            blockTime: B.barrierBlockTime, processedAt: B.processedAt,
            samples: stillClosed, graceS: GRACE_S, sampleIntervalS: 15
        });
        assert.strictEqual(a.escape, 'unknown');
        assert.strictEqual(a.beforePermission, 'observed-closed-across-processing');
        assert.ok(/processed while neither shipped clause was satisfied/.test(a.reason));
    });
}

function registerPermissionClockChecks(SERIES) {
    it('stays `unknown` when the sampling simply stops at processing', function () {
        // Same closed readings, but nothing after the block was seen
        // processed. `processedAt` is a DETECTION stamp and an upper bound, so
        // this cannot be told apart from a barrier that opened in the gap, and
        // claiming a violation here would be reading the sampling grid.
        const upToOnly = SERIES
            .filter((s) => s.at <= B.processedAt)
            .map((s) => Object.assign({}, s, { streamWatermark: 1788982085, priceSyncMaxTimestamp: 0 }));
        const a = drill.attributeEscape({
            blockTime: B.barrierBlockTime, processedAt: B.processedAt,
            samples: upToOnly, graceS: GRACE_S, sampleIntervalS: 15
        });
        assert.strictEqual(a.escape, 'unknown');
        assert.strictEqual(a.beforePermission, 'unknown');
    });

    it('THE WRONG CLOCK MANUFACTURES A VIOLATION, which is what run 5 hit', function () {
        // Exactly the series that attributes cleanly against the protocol
        // time, re-read against the chain's RAW stamp. The watermark never
        // reaches rawBlockTime + grace, so a real barrier opening reads as the
        // node running ahead of it. If this assertion ever flips to a clean
        // attribution, the drill has started measuring on the raw stamp again.
        const a = drill.attributeEscape({
            blockTime: B.rawBlockTime, processedAt: B.processedAt,
            samples: SERIES, graceS: GRACE_S, sampleIntervalS: 15
        });
        assert.strictEqual(a.escape, 'unknown');
        assert.strictEqual(a.beforePermission, 'observed-closed-across-processing');

        // And the same readings against the clock the node used.
        const good = drill.attributeEscape({
            blockTime: B.barrierBlockTime, processedAt: B.processedAt,
            samples: SERIES, graceS: GRACE_S, sampleIntervalS: 15
        });
        assert.strictEqual(good.escape, 'watermark');
        assert.strictEqual(good.beforePermission, 'no');
    });
}


describe('AT5 barrier drill: which escape opened the block (row 56)', function () {
    describe('the sampled attribution, over the same window', registerSampledAttribution);
    describe("TA5's second half: was the block processed BEFORE the barrier permitted it?",
        registerBeforePermission);
});
