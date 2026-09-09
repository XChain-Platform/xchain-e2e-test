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
 * THE AT5 DRILL'S ESCAPE ATTRIBUTION (spec row 56), pinned without a chain.
 *
 * WHAT WENT WRONG. Run 5 (2026-09-09) graded 290 blocks and could name the
 * escape for ONE: 289 read `escape: "none"` with `deferralCount: 0`, on blocks
 * that had each waited over 4,400 seconds. TA5's "never BEFORE the barrier
 * permits" half was therefore unmeasured, and the run said nothing about it.
 *
 * TWO CAUSES, both measured and both pinned below.
 *
 *   1. THE EVIDENCE WAS A LOG LINE THE NODE ALMOST NEVER PRINTS.
 *      `hub_db_sync.waitForPriceSyncTime` returns an already-resolved promise
 *      when the barrier is satisfied and resolves a pending waiter silently the
 *      moment it opens, so `Deferring block N (price time-sync)` is reached only
 *      when one attempt runs out its HUB_PRICE_SYNC_TIMEOUT_MS (60 s). At this
 *      node's working point the residual wait per block is shorter than that:
 *      one block of run 5's 290 timed out, three times, and 289 said nothing.
 *      The capture was never at fault; there was nothing to capture.
 *
 *   2. THE ATTRIBUTION REASONED ON THE WRONG CLOCK. The barrier is called with
 *      `decoderDb.getBlockTime()`, which on testnet resolves PROTOCOL time
 *      (median time past over 11 preceding stamps, db.js:2470 via
 *      protocol_time.js), not the chain's raw header stamp the drill read from
 *      the decoder. On run 5's one deferred block the two differ by 206 s, and
 *      the difference is the whole reason its stalls topped out at 4,607 s
 *      against a 4,800 s grace: a run that looked like a barrier opening early
 *      was a drill measuring against a clock the node never used.
 *
 * EVERY NUMBER BELOW IS A READING, NOT A FIXTURE. The block times come from the
 * public explorer's own `/TDOGE/api/block/<height>`; the barrier state samples
 * are the three deferral lines run 5's result file carries verbatim, which are
 * the indexer's own print of `priceSyncMaxTimestamp` and `streamWatermark`; and
 * the grace and the predicate are taken from xchain-indexer itself where it is
 * checked out beside this repo, so a drift in either shows up here as a failure
 * rather than as another four-hour run.
 *
 *   npx mocha --no-config test/unit/oracleBatchBarrierEscape.test.js
 ********************************************************************/

const assert = require('assert');
const path   = require('path');

const drill = require('../drills/oracleBatchBarrierTestnet.drill.js');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

// The sibling indexer, where it is checked out. Every assertion that depends on
// it is skipped rather than silently weakened when it is not: a false green on
// the consensus half of this file would be worse than a gap.
// ABSENCE may skip; PRESENT-BUT-BROKEN must be red. Resolving is guarded, the
// load is not, so a sibling that exists and throws fails this file rather than
// turning the consensus half of it into a silent pass.
function sibling(rel) {
    const p = path.join(REPO_ROOT, 'xchain-indexer', 'src', rel);
    try { require.resolve(p); } catch (e) { return null; }
    return require(p);
}
const protocolTime = sibling('protocol_time.js');
// hub_db_sync.js exports the CLASS itself (module.exports = HubDbSync), with the
// constants hung off it as properties.
const HubDbSync    = sibling('hub_db_sync.js');
const haveHubDbSync = typeof HubDbSync === 'function' &&
    typeof HubDbSync.prototype._priceTimeSyncSatisfied === 'function';

// ---------------------------------------------------------------------------
// Run 5's own readings
// ---------------------------------------------------------------------------

// Block 67881904 of TDOGE, the ONE block of run 5's 290 that ever timed out at
// the barrier and therefore the only one whose barrier state the old attribution
// could see at all.
const B = {
    height: 67881904,
    // The chain's raw stamp, as the decoder recorded it and as the public
    // explorer still serves it at /TDOGE/api/block/67881904.
    rawBlockTime: 1788982721,
    // The time the INDEXER was waiting on, quoted from its own deferral line:
    // "waiting for block time 1788982515". This is the protocol time.
    barrierBlockTime: 1788982515,
    // processedAt, from the result file: block time + the recorded stallS 4607.
    processedAt: 1788982721 + 4607
};

// The eleven stamps preceding it, read from the public explorer one block at a
// time, in the DESCENDING order `db.getPreviousBlockTimes` returns them.
const PREV_11_DESC = [
    1788982673, 1788982671, 1788982651, 1788982611, 1788982537, 1788982515,
    1788982511, 1788982496, 1788982471, 1788982456, 1788982383
];

// The three deferral lines run 5 captured for that block, as barrier samples.
// Each is the indexer printing its own priceSyncMaxTimestamp and streamWatermark
// at an instant the predicate was false. The middle one is reconstructed at the
// 60 s retry cadence the other two bracket exactly (1788987133 -> 1788987263).
const RUN5_DEFERRAL_SAMPLES = [
    { at: 1788987133, source: 'deferral', priceSyncMaxTimestamp: 1788982085, streamWatermark: 1788987132 },
    { at: 1788987193, source: 'deferral', priceSyncMaxTimestamp: 1788982085, streamWatermark: 1788987192 },
    { at: 1788987263, source: 'deferral', priceSyncMaxTimestamp: 1788982085, streamWatermark: 1788987262 }
];

const GRACE_S = 4800;

// The /status series the FIXED drill takes, over the same window.
//
// The watermark trajectory is not invented: both real deferral readings above
// show `streamWatermark` exactly one second behind the instant the line was
// parsed (1788987133/1788987132 and 1788987263/1788987262), which is the hub's
// own clock advancing in real time. Extending that measured relationship across
// a 15 s poll grid (POLL_MS) is what the drill would have recorded had it been
// sampling, and it is the only quantity here that is projected rather than read.
function statusSeries(fromAt, toAt, stepS) {
    const out = [];
    for (let t = fromAt; t <= toAt; t += stepS) {
        out.push({
            at: t, source: 'status', bootstrapped: true,
            priceSyncMaxTimestamp: 1788982085,
            streamWatermark: t - 1
        });
    }
    return out;
}

// ---------------------------------------------------------------------------

describe('AT5 barrier drill: which escape opened the block (row 56)', function () {

    describe('barrierClauses mirrors the SHIPPED predicate, clause for clause', function () {

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
                inst._priceMirrorRefloor   = false;
                inst.priceSyncMaxTimestamp = maxTs;
                inst.streamWatermark       = watermark;
                inst.priceWatermarkGraceS  = GRACE_S;
                return inst._priceTimeSyncSatisfied(blockTime);
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
    });

    describe('the clock the barrier gates on is the PROTOCOL time, not the raw stamp', function () {

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
    });

    describe("run 5's own evidence, re-read", function () {

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
    });

    describe('the sampled attribution, over the same window', function () {

        // The drill polls /status every POLL_MS; this is that series across the
        // instant run 5's block was released, at the watermark rate both of its
        // real deferral readings measured.
        const SERIES = statusSeries(1788987133, B.processedAt, 15);

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
    });

    describe("TA5's second half: was the block processed BEFORE the barrier permitted it?", function () {

        const SERIES = statusSeries(1788987133, B.processedAt + 60, 15);

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
    });

    describe('a block the barrier never gated', function () {

        // `blockMayReadPrice` is `blockTransactions.length > 0`
        // (priceReadPredicate.js), reached through `_evaluatePriceBarrier`. A
        // transaction-free block is committed without the barrier ever being
        // consulted, and on TDOGE that is nearly every block: 289 of run 5's 290.
        const CLOSED_THROUGHOUT = statusSeries(1788987133, B.processedAt + 60, 15)
            .map((s) => Object.assign({}, s, { streamWatermark: 1788982085, priceSyncMaxTimestamp: 0 }));

        it('mirrors the shipped predicate on what "applies" means', function () {
            const pred = sibling('priceReadPredicate.js');
            if (!pred) return this.skip();
            assert.strictEqual(pred.blockMayReadPrice([]), false, 'an empty block reads no price');
            assert.strictEqual(pred.blockMayReadPrice([{}]), true);
            // Anything unreadable is an over-approximation to "wait", so the drill
            // must not read an unknown count as "did not apply" either.
            assert.strictEqual(pred.blockMayReadPrice(null), true);
        });

        it('reports not-applicable instead of manufacturing a violation', function () {
            const a = drill.attributeEscape({
                blockTime: B.barrierBlockTime, processedAt: B.processedAt,
                samples: CLOSED_THROUGHOUT, graceS: GRACE_S, sampleIntervalS: 15,
                barrierApplies: false
            });
            assert.strictEqual(a.escape, 'not-applicable');
            assert.strictEqual(a.beforePermission, 'not-applicable');
            assert.ok(/never entered the price time barrier/.test(a.reason));
        });

        it('and the SAME readings do read as a violation when the barrier did apply', function () {
            // The check above is only worth anything if the readings it excuses
            // would otherwise be a finding.
            const a = drill.attributeEscape({
                blockTime: B.barrierBlockTime, processedAt: B.processedAt,
                samples: CLOSED_THROUGHOUT, graceS: GRACE_S, sampleIntervalS: 15,
                barrierApplies: true
            });
            assert.strictEqual(a.beforePermission, 'observed-closed-across-processing');
        });

        it('leaves the question open when the transaction count was never read', function () {
            const a = drill.attributeEscape({
                blockTime: B.barrierBlockTime, processedAt: B.processedAt,
                samples: CLOSED_THROUGHOUT, graceS: GRACE_S, sampleIntervalS: 15
            });
            assert.notStrictEqual(a.escape, 'not-applicable',
                'an unread count must not be taken as "the barrier did not apply"');
            assert.strictEqual(a.beforePermission, 'observed-closed-across-processing');
        });

        it('asks the decoder the same question the indexer asks', async function () {
            const asked = [];
            const conn = {
                async query(sql, params) { asked.push({ sql: sql, params: params }); return [{ n: 0 }]; }
            };
            const n = await drill.decoderBlockTransactionCount(conn, 'Decoder', B.height);
            assert.strictEqual(n, 0);
            assert.ok(/FROM `Decoder`\.transactions/.test(asked[0].sql), asked[0].sql);
            assert.deepStrictEqual(asked[0].params, [B.height]);
        });
    });

    describe('a deferral line is a sample of the same two fields', function () {

        it('parses the indexer\'s own wording into the barrier\'s inputs', function () {
            // Verbatim from run 5's result file, including the indexer's double
            // space after the colon.
            const line = '2026-09-09T20:52:13.417Z warn [xchain-indexer] Deferring block 67881904 ' +
                '(price time-sync):  Error: price time-sync barrier timed out after 60000ms waiting ' +
                'for block time 1788982515 (mirror max round timestamp 1788982085, stream watermark ' +
                'at 1788987132)';
            const parsed = drill.parseDeferral(line);
            assert.ok(parsed, 'the drill must parse the wording the indexer actually prints');
            assert.strictEqual(parsed.height, 67881904);
            const sample = drill.barrierSampleFromDeferral(parsed);
            assert.strictEqual(sample.source, 'deferral');
            assert.strictEqual(sample.priceSyncMaxTimestamp, 1788982085);
            assert.strictEqual(sample.streamWatermark, 1788987132);
            // And it reads as a CLOSED barrier for the block it names, which is
            // the only thing a timeout can ever be evidence of.
            const c = drill.barrierClauses(sample, B.barrierBlockTime, GRACE_S);
            assert.strictEqual(c.content, false);
            assert.strictEqual(c.watermark, false);
        });

        it('is ordered in with the status samples rather than read separately', function () {
            // A deferral that lands between two status samples must be the one
            // that carries the last closed reading, or the two evidence sources
            // are not really in one model.
            const status = [
                { at: 1788987100, source: 'status', priceSyncMaxTimestamp: 0, streamWatermark: 1788987099 },
                { at: 1788987330, source: 'status', priceSyncMaxTimestamp: 0,
                  streamWatermark: B.barrierBlockTime + GRACE_S }
            ];
            const a = drill.attributeEscape({
                blockTime: B.barrierBlockTime, processedAt: B.processedAt + 10,
                samples: status.concat(RUN5_DEFERRAL_SAMPLES), graceS: GRACE_S, sampleIntervalS: 15
            });
            assert.strictEqual(a.escape, 'watermark');
            assert.strictEqual(a.permittedAt, 1788987330);
            assert.strictEqual(a.lastClosedAt, 1788987263, 'the deferral is the newest closed reading');
            assert.strictEqual(a.permittedBy, 'status');
        });
    });

    describe('readBarrierState reads the fields mirrorStatus actually publishes', function () {

        it('maps hubMirror onto the predicate\'s two inputs', async function () {
            if (!haveHubDbSync) return this.skip();
            // The shipped mirrorStatus(), driven on a real instance, so the field
            // names this drill reaches for are the ones the endpoint emits.
            const inst = Object.create(HubDbSync.prototype);
            inst.enabled = true;
            inst.ws = null;
            inst._bootstrapDrained = true;
            inst.streamWatermark = 1788987132;
            inst.priceSyncMaxTimestamp = 1788982085;
            inst.oracleSyncTimestamp = 0;
            inst.matchSyncTimestamp = 0;
            inst.callSyncTimestamp = 0;
            const status = inst.mirrorStatus();
            assert.strictEqual(status.streamWatermark, 1788987132);
            assert.strictEqual(status.tables.price_snapshots, 1788982085,
                'the drill reads priceSyncMaxTimestamp out of tables.price_snapshots');

            // And the drill's reader turns that same body into a sample.
            const sample = await readViaStub({ hubMirror: status, indexerBlock: 67881904, stallReason: null });
            assert.strictEqual(sample.streamWatermark, 1788987132);
            assert.strictEqual(sample.priceSyncMaxTimestamp, 1788982085);
            assert.strictEqual(sample.error, null);
            const c = drill.barrierClauses(sample, B.barrierBlockTime, GRACE_S);
            assert.strictEqual(c.content, false);
            assert.strictEqual(c.watermark, false);
        });

        it('records a failed read as a gap, never as a satisfied barrier', async function () {
            for (const body of [{}, { hubMirror: { configured: false } }]) {
                const sample = await readViaStub(body);
                assert.strictEqual(sample.streamWatermark, null);
                assert.strictEqual(sample.priceSyncMaxTimestamp, null);
                assert.ok(sample.error, 'a gap must carry its reason');
                const c = drill.barrierClauses(sample, B.barrierBlockTime, GRACE_S);
                assert.strictEqual(c.content, false);
                assert.strictEqual(c.watermark, false);
            }
        });
    });
});

// A real HTTP round trip against a loopback server, so the reader is driven
// through axios the way a run drives it rather than around it.
async function readViaStub(body) {
    const http = require('http');
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        return await drill.readBarrierState(server.address().port);
    } finally {
        await new Promise((r) => server.close(r));
    }
}
