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
const { drill, REPO_ROOT, protocolTime, HubDbSync, haveHubDbSync, B, PREV_11_DESC, RUN5_DEFERRAL_SAMPLES, GRACE_S } = require('./helpers/fixtures.js');

function registerPredicateMirror() {
    // The differential test. `_priceTimeSyncSatisfied` is the code that
    // actually decides; anything the drill says about the barrier that this
    // disagrees with is a second definition of the barrier, which is the one
    // thing the attribution must never become.
    it('agrees with hub_db_sync._priceTimeSyncSatisfied on every case', function () {
        if (!haveHubDbSync) return this.skip();
        const proto = HubDbSync.prototype;

        const shipped = (maxTs, watermark, blockTime) => {
            const inst = Object.create(proto);
            inst.priceBootstrapped     = true;
            inst['_priceMirrorRefloor']   = false;
            inst.priceSyncMaxTimestamp = maxTs;
            inst.streamWatermark       = watermark;
            inst.priceWatermarkGraceS  = GRACE_S;
            return inst['_priceTimeSyncSatisfied'](blockTime);
        };

        const blockTime = B.barrierBlockTime;
        const cases = [
            // [priceSyncMaxTimestamp, streamWatermark]
            [0, 0],
            [blockTime - 1, blockTime - 1],
            [blockTime,     0],                       // content, exactly on the boundary
            [blockTime + 1, 0],                       // content, past it
            [0, blockTime + GRACE_S - 1],             // watermark, one short
            [0, blockTime + GRACE_S],                 // watermark, exactly on the boundary
            [0, blockTime + GRACE_S + 1],             // watermark, past it
            [blockTime, blockTime + GRACE_S],         // both at once
            [1788982085, 1788987262],                 // run 5's own last closed reading
            [1788982085, 1788987315]                  // the instant it would have opened
        ];
        let openCases = 0, closedCases = 0;
        for (const [maxTs, watermark] of cases) {
            const c = drill.barrierClauses(
                { priceSyncMaxTimestamp: maxTs, streamWatermark: watermark }, blockTime, GRACE_S);
            const mine = c.content || c.watermark;
            assert.strictEqual(mine, shipped(maxTs, watermark, blockTime),
                'disagreed on priceSyncMaxTimestamp=' + maxTs + ', streamWatermark=' + watermark);
            if (mine) openCases++; else closedCases++;
        }
        // A comparison in which every case falls the same way proves nothing
        // about the boundary, so the set must exercise both sides of it.
        assert.ok(openCases >= 4 && closedCases >= 4,
            'the case set must straddle the boundary: ' + openCases + ' open, ' + closedCases + ' closed');
    });

registerReadingGapsAndGrace();
}

function registerReadingGapsAndGrace() {
    it('takes a missing reading as an unsatisfied clause, never a satisfied one', function () {
        const bt = 1_000_000;
        for (const s of [{}, { priceSyncMaxTimestamp: null, streamWatermark: null },
                         { priceSyncMaxTimestamp: 'x', streamWatermark: undefined }]) {
            const c = drill.barrierClauses(s, bt, GRACE_S);
            assert.strictEqual(c.content, false);
            assert.strictEqual(c.watermark, false);
        }
    });

    it('is pinned to the grace the indexer freezes', function () {
        if (!HubDbSync || !HubDbSync.HUB_SYNC_WATERMARK_GRACE_S) return this.skip();
        assert.strictEqual(Number(HubDbSync.HUB_SYNC_WATERMARK_GRACE_S.price), GRACE_S,
            'the drill reasons about a grace the indexer no longer uses');
    });
}

function registerProtocolClock() {
    it("reproduces the indexer's own quoted block time for run 5's deferred block", function () {
        if (!protocolTime) return this.skip();
        const resolved = protocolTime.protocolTime('testnet', B.rawBlockTime, PREV_11_DESC);
        // The indexer printed this number itself: "waiting for block time
        // 1788982515". Reproducing it from the public explorer's stamps is
        // what makes the drill's clock the node's clock and not a model of it.
        assert.strictEqual(resolved, B.barrierBlockTime);
        assert.strictEqual(B.rawBlockTime - resolved, 206,
            'the two clocks differ, and by how much is the whole defect');
    });

    it('resolves it through the shipped module, over the shipped window', async function () {
        if (!protocolTime) return this.skip();
        const asked = [];
        const conn = {
            async query(sql, params) {
                asked.push({ sql: sql, params: params });
                return PREV_11_DESC.map((t) => ({ block_time: t }));
            }
        };
        const got = await drill.resolveBarrierBlockTime(
            conn, 'Decoder', B.height, B.rawBlockTime, 'testnet', REPO_ROOT);
        assert.strictEqual(got.blockTime, B.barrierBlockTime);
        assert.strictEqual(got.source, 'mtp');
        // The window must be the consensus one, read the way the node reads it.
        assert.strictEqual(asked.length, 1);
        assert.deepStrictEqual(asked[0].params, [B.height, protocolTime.MEDIAN_TIME_SPAN]);
        assert.ok(/block_index < \?/.test(asked[0].sql) && /ORDER BY block_index DESC/.test(asked[0].sql),
            'the median window must be the preceding blocks, newest first');
        assert.ok(/block_time IS NOT NULL/.test(asked[0].sql),
            'a null stamp is not part of the median');
    });

    it('is the raw stamp on a network that has not switched, without asking the decoder', async function () {
        if (!protocolTime) return this.skip();
        let queried = 0;
        const conn = { async query() { queried++; return []; } };
        for (const network of ['mainnet', 'regtest']) {
            const got = await drill.resolveBarrierBlockTime(
                conn, 'Decoder', B.height, B.rawBlockTime, network, REPO_ROOT);
            assert.strictEqual(got.blockTime, B.rawBlockTime, network);
            assert.strictEqual(got.source, 'raw', network);
        }
        assert.strictEqual(queried, 0, 'an unswitched network needs no median window');
    });

    it('refuses to guess a clock it could not load, rather than falling back to the raw stamp', async function () {
        const conn = { async query() { return []; } };
        const got = await drill.resolveBarrierBlockTime(
            conn, 'Decoder', B.height, B.rawBlockTime, 'testnet', '/no/such/checkout');
        assert.strictEqual(got.blockTime, null);
        assert.strictEqual(got.source, 'unavailable');
        assert.ok(/protocol_time/.test(got.note));
    });
}

function registerRun5Evidence() {
    it('attributes NOTHING from run 5\'s deferral lines, and says why', function () {
        // Every sample run 5 has for this block shows the barrier CLOSED. An
        // honest attribution therefore names no escape at all. What the old
        // code did instead was call it 'watermark' by elimination, which is
        // an inference about the barrier rather than a reading of it.
        const a = drill.attributeEscape({
            blockTime: B.barrierBlockTime, processedAt: B.processedAt,
            samples: RUN5_DEFERRAL_SAMPLES, graceS: GRACE_S, sampleIntervalS: 60
        });
        assert.strictEqual(a.escape, 'unknown');
        assert.strictEqual(a.permittedAt, null);
        assert.strictEqual(a.lastClosedAt, 1788987263);
        assert.ok(a.reason && a.reason.length > 0, 'an unknown must carry its reason');
        assert.ok(/observed closed/.test(a.reason));
    });

    it('never returns the old `none`, whatever it is given', function () {
        const shapes = [
            { blockTime: B.barrierBlockTime, processedAt: B.processedAt, samples: [] },
            { blockTime: B.barrierBlockTime, processedAt: B.processedAt, samples: RUN5_DEFERRAL_SAMPLES },
            { blockTime: null, processedAt: B.processedAt, samples: RUN5_DEFERRAL_SAMPLES },
            { blockTime: B.barrierBlockTime, processedAt: null, samples: RUN5_DEFERRAL_SAMPLES },
            // Samples that all postdate the block being processed.
            { blockTime: B.barrierBlockTime, processedAt: 1788987000, samples: RUN5_DEFERRAL_SAMPLES }
        ];
        const seen = new Set();
        for (const s of shapes) {
            const a = drill.attributeEscape(Object.assign({ graceS: GRACE_S }, s));
            assert.notStrictEqual(a.escape, 'none',
                "'none' is the value that made TA5's second half unmeasurable");
            assert.ok(['content', 'watermark', 'both', 'unknown'].includes(a.escape), a.escape);
            assert.ok(a.reason && a.reason.length > 0, 'every verdict carries a reason: ' + a.escape);
            seen.add(a.reason);
        }
        // The reasons must actually differ; one catch-all string would tell a
        // reader nothing about which gap they are looking at.
        assert.ok(seen.size >= 3, 'the reasons must distinguish the cases, got ' + seen.size);
    });
}


describe('AT5 barrier drill: which escape opened the block (row 56)', function () {
    describe('barrierClauses mirrors the SHIPPED predicate, clause for clause', registerPredicateMirror);
    describe('the clock the barrier gates on is the PROTOCOL time, not the raw stamp', registerProtocolClock);
    describe("run 5's own evidence, re-read", registerRun5Evidence);
});
