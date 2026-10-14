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
 * Shared fixtures for the AT5 observe-gate suite: run 3's own numbers and
 * the drill's real observeBlock driven over a node that holds no rows.
 ********************************************************************/

const assert = require('assert');

const drill = require('../../../drills/lib/oracle_batch_barrier_testnet.js');

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
        // The barrier state series the escape attribution reads (row 56). These
        // fixtures are regtest-shaped, so the barrier clock is the raw stamp and
        // observeBlock's own `raw-assumed` default is the right one.
        barrierSamples: opts.barrierSamples || [],
        sampleIntervalS: opts.sampleIntervalS === undefined ? 15 : opts.sampleIntervalS,
        // These fixtures are about blocks the barrier DID gate, so they carry a
        // transaction: `blockMayReadPrice` is `blockTransactions.length > 0`, and
        // a transaction-free block never enters the barrier at all (row 56).
        blockTransactionCount: opts.blockTransactionCount === undefined ? 1 : opts.blockTransactionCount,
        originNow: { lag: 0, blockIndex: opts.height },
        maxBlockAgeS: opts.maxBlockAgeS === undefined ? DEFAULTS.maxBlockAgeS : opts.maxBlockAgeS
    });
}

// A /status poll series across a block's hold, at the rate the drill polls. The
// hub's stream watermark is its own clock, so it tracks the sample instant; the
// mirror is left behind the block, which is the chain-only node D61 describes.
function sampleSeries(fromAt, toAt, stepS, blockTime) {
    const out = [];
    for (let t = fromAt; t <= toAt; t += stepS) {
        out.push({
            at: t, source: 'status', bootstrapped: true,
            priceSyncMaxTimestamp: blockTime - 5000,
            streamWatermark: t - 1
        });
    }
    return out;
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
async function liveObservations(stalls, opts) {
    opts = opts || {};
    const out = [];
    for (let i = 0; i < stalls.length; i++) {
        const blockTime = 1_757_500_000 + i * 60;
        const height = 67_900_000 + i;
        const firstSeenAt = blockTime + 18;       // one poll after the decoder had it
        const processedAt = blockTime + stalls[i];
        out.push(await observe({
            height: height,
            blockTime: blockTime,
            firstSeenAt: firstSeenAt,
            processedAt: processedAt,
            deferrals: [deferralFor(height, blockTime)],
            blockTransactionCount: opts.blockTransactionCount,
            barrierSamples: opts.barrierSamples
                ? opts.barrierSamples(blockTime, firstSeenAt, processedAt)
                : sampleSeries(firstSeenAt, processedAt + 15, 15, blockTime)
        }));
    }
    return out;
}

module.exports = {
    drill, GRACE_S, DEFAULTS, RUN3, RUN3_BASE_BLOCK_TIME,
    observe, deferralFor, sampleSeries, run3Observations, liveObservations
};
