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
const { drill, sibling, HubDbSync, haveHubDbSync, B, RUN5_DEFERRAL_SAMPLES, GRACE_S, statusSeries } = require('./helpers/fixtures.js');

function registerUngatedBlock() {
    // `blockMayReadPrice` is `blockTransactions.length > 0`
    // (src/chain/price_read_predicate.js), reached through
    // `evaluatePriceBarrier`. A
    // transaction-free block is committed without the barrier ever being
    // consulted, and on TDOGE that is nearly every block: 289 of run 5's 290.
    const CLOSED_THROUGHOUT = statusSeries(1788987133, B.processedAt + 60, 15)
        .map((s) => Object.assign({}, s, { streamWatermark: 1788982085, priceSyncMaxTimestamp: 0 }));

registerUngatedVerdicts(CLOSED_THROUGHOUT);
registerUngatedCountChecks(CLOSED_THROUGHOUT);
}

function registerUngatedVerdicts(CLOSED_THROUGHOUT) {
    it('mirrors the shipped predicate on what "applies" means', function () {
        const pred = sibling('chain/price_read_predicate.js');
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
}

function registerUngatedCountChecks(CLOSED_THROUGHOUT) {
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
}

function registerDeferralSample() {
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
}

function registerReadBarrierState() {
    it('maps hubMirror onto the predicate\'s two inputs', async function () {
        if (!haveHubDbSync) return this.skip();
        // The shipped mirrorStatus(), driven on a real instance, so the field
        // names this drill reaches for are the ones the endpoint emits.
        const inst = Object.create(HubDbSync.prototype);
        inst.enabled = true;
        inst.ws = null;
        inst['_bootstrapDrained'] = true;
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
}

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


describe('AT5 barrier drill: which escape opened the block (row 56)', function () {
    describe('a block the barrier never gated', registerUngatedBlock);
    describe('a deferral line is a sample of the same two fields', registerDeferralSample);
    describe('readBarrierState reads the fields mirrorStatus actually publishes', registerReadBarrierState);
});
