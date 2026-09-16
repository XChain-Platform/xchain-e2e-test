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
 * L3 integration: AT2, chain self-sufficiency.
 *
 * THE CLAIM UNDER TEST is the one the whole PRICE v0 spec rests on: the chain
 * alone is enough to rebuild price history. A node that was not there when the
 * federation ran, that has no peer to ask and no database to inherit, must be
 * able to read the chain and arrive at the same price_snapshots and the same fee
 * verdicts as a node that was live the whole time.
 *
 * HOW THE RUN IS SHAPED, and why both sides are built rather than borrowed:
 *
 *   1. a LIVE node comes up first (fresh indexer, its own fresh empty hub, no
 *      peers) and catches up to the chain tip,
 *   2. `oracleBatchVenue` then drives a real quorum federation and publishes
 *      real PRICE transactions onto DOGE regtest, which the live node sees
 *      arrive block by block,
 *   3. the federation is torn down, taking its databases with it,
 *   4. a REPLAY node comes up (the same construction, brand new) and reads the
 *      whole chain from block 0,
 *   5. the two are compared.
 *
 * The live side is BUILT rather than pointed at the standing stack for one
 * measured reason: the only path that writes a chain-derived `price_snapshots`
 * row is `PriceAggregator.receiveValidatedRound`/`receiveValidatedBatch`, whose
 * `reference_block` is the block the PRICE landed in, while a federation hub's
 * own `OracleConsensus` rows put the BTC anchor height in that same column.
 * Comparing those two would be comparing two different quantities on a key AT2
 * explicitly names. Both sides here reconstruct through the same path.
 *
 * WHAT THE CLAIM IS SCOPED TO, and why the scope is the architecture rather than
 * a caveat. Chain-only reconstruction REQUIRES the node to also run a Bitcoin
 * indexer. Capability staking is Bitcoin-only by design, so a node with no
 * Bitcoin view legitimately cannot resolve who was eligible to sign a batch: the
 * qualifying `price` set is anchored to a Bitcoin height, the hub reads it from a
 * BTC indexer, and its indexer twin reads a mirror of that same Bitcoin-anchored
 * set. Inventing a second trust path for validator identity that does not go
 * through Bitcoin would be worse than scoping the claim, so a Bitcoin indexer is
 * a stated PRECONDITION of "chain as backup of last resort", not a workaround
 * for a gap in it.
 *
 * Both nodes here are therefore built with one: a real BTC indexer as their
 * capability oracle, verified to report Bitcoin for itself before either node is
 * trusted, with the hub's own coin check left ON. Nothing is stubbed or skipped
 * past to manufacture a pass, no guard is disabled, and the two halves of the
 * comparison are configured identically, which is what keeps the comparison
 * sound.
 *
 * WHEN IT IS STILL RED, this suite names the rung rather than reporting a vague
 * mismatch: which of parse, signer resolution, push and mirror the reconstruction
 * stopped at, the verdict every PRICE received, and how many received it.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');

const { OracleBatchVenue }     = require('../../helpers/oracleBatchVenue');
const { startDisposableHubDb } = require('../../helpers/disposableHubDb');
const { loadHubModule }        = require('../../helpers/multiValidatorHubHelper');
const {
    OracleBatchReplayNode,
    SNAPSHOT_COMPARE_KEYS,
    diffSnapshots,
    diffVerdicts
} = require('../../helpers/oracleBatchReplay');

const {
    VALIDATORS, ROUNDS, CAPABILITY_GAP_STATUS, PRICE_GRACE_S,
    BATCH_WINDOW_ROUNDS, BATCH_GRACE_MS, histogram, describeHistogram
} = require('./constants.test');

let hubDb   = null;
let liveNode = null;
let replayNode = null;
let venue   = null;

let rounds        = [];      // what the federation finalized
let expectedPairs = [];      // {round, coinPair} the federation put on the chain
let targetHeight  = null;    // the block the last publish landed in

let livePrices = [], replayPrices = [];        // PRICE actions each node decided
let liveSnaps  = [], replaySnaps  = [];        // price_snapshots each node's hub rebuilt
let replayMirror = [];                         // what hub_db_sync carried back down
let snapDiff = null, verdictDiff = null, feeVerdictDiff = null;
let liveIsolation = null, replayIsolation = null;
let liveVerdicts = new Map(), replayVerdicts = new Map();
let savedBatchEnv = null;
let wireVersions = [];
let venuePublicationBytes = [];
let feeCoordinates = new Set();
let feeStatuses = null;
let livePushQueue = [], replayPushQueue = [];

const state = {};
Object.defineProperties(state, {
    hubDb: { get() { return hubDb; } }, liveNode: { get() { return liveNode; } },
    replayNode: { get() { return replayNode; } }, venue: { get() { return venue; } },
    rounds: { get() { return rounds; } }, expectedPairs: { get() { return expectedPairs; } },
    targetHeight: { get() { return targetHeight; } }, livePrices: { get() { return livePrices; } },
    replayPrices: { get() { return replayPrices; } }, liveSnaps: { get() { return liveSnaps; } },
    replaySnaps: { get() { return replaySnaps; } }, replayMirror: { get() { return replayMirror; } },
    snapDiff: { get() { return snapDiff; } }, verdictDiff: { get() { return verdictDiff; } },
    feeVerdictDiff: { get() { return feeVerdictDiff; } }, liveIsolation: { get() { return liveIsolation; } },
    replayIsolation: { get() { return replayIsolation; } }, liveVerdicts: { get() { return liveVerdicts; } },
    replayVerdicts: { get() { return replayVerdicts; } }, wireVersions: { get() { return wireVersions; } },
    venuePublicationBytes: { get() { return venuePublicationBytes; } },
    feeCoordinates: { get() { return feeCoordinates; } }, feeStatuses: { get() { return feeStatuses; } },
    livePushQueue: { get() { return livePushQueue; } }, replayPushQueue: { get() { return replayPushQueue; } }
});

async function bail(why) {
    console.log('AT2 unavailable: ' + why);
    if (venue) await venue.down();
    if (replayNode) await replayNode.down();
    if (liveNode) await liveNode.down();
    if (hubDb) await hubDb.stop();
    venue = replayNode = liveNode = hubDb = null;
}

async function skipUnavailable(context, why) {
    if (why) await bail(why);
    context.skip();
}

// Started here, once, and shared with everything below. The venue's own
// startDisposableHubDb call resolves this same handle out of the
// environment and returns a no-op stop(), so tearing the federation down
// cannot take the replay node's database server with it.
async function startLiveNode(context) {
    hubDb = await startDisposableHubDb();
    if (!hubDb) {
        console.log('AT2 unavailable: no env hub DB and Docker unavailable');
        await skipUnavailable(context);
        return;
    }

    // --- 1. the live node, up and caught up BEFORE anything is published ---
    liveNode = new OracleBatchReplayNode({
        label: 'live', hubDb: hubDb, basePort: 61000, priceGraceS: PRICE_GRACE_S });
    let up = false;
    try { up = await liveNode.up(); }
    catch (err) { await skipUnavailable(context, 'live node failed to build: ' + (err && err.message)); return; }
    if (!up) { await skipUnavailable(context, liveNode.unavailable); return; }
    liveIsolation = await liveNode.isolationEvidence();

    // Catching up to the CURRENT tip first is what makes this node "live": from
    // here on it sees the venue's publishes arrive as new blocks, exactly as a
    // node that had always been running would. The target comes from the DECODER,
    // which is the chain, so "caught up" is a claim about the chain and not about
    // the node's own progress having stopped moving.
    const tipBefore = (await liveNode.decoderHeight()).height;
    console.log('  AT2: live node built; catching up to chain block ' + tipBefore + '...');
    await liveNode.waitForHeight(tipBefore);
    console.log('  AT2: live node caught up at block ' + (await liveNode.chainHeight()).height);
}

// --- 2. the federation publishes onto the chain the nodes are reading ---
async function startVenue(context) {
    savedBatchEnv = {
        ORACLE_BATCH_WINDOW_ROUNDS: process.env.ORACLE_BATCH_WINDOW_ROUNDS,
        ORACLE_BATCH_GRACE_MS:      process.env.ORACLE_BATCH_GRACE_MS
    };
    process.env.ORACLE_BATCH_WINDOW_ROUNDS = String(BATCH_WINDOW_ROUNDS);
    process.env.ORACLE_BATCH_GRACE_MS      = String(BATCH_GRACE_MS);

    venue = new OracleBatchVenue({
        coin: 'dogecoin', network: 'regtest',
        validatorCount: VALIDATORS, basePort: 33900, expectWireVersion: 0
    });
    let venueUp = false;
    try { venueUp = await venue.up(); }
    catch (err) { await skipUnavailable(context, 'publish venue failed to build: ' + (err && err.message)); return; }
    if (!venueUp) await skipUnavailable(context, venue.unavailable);
}

// Keep the batch BUFFER out of the checkout.
//
// OraclePublisher derives `bufferPath` from `queuePath` in its CONSTRUCTOR
// (`this.queuePath.replace(/\.jsonl$/, '') + '.buffer.jsonl'`), and the venue
// redirects `queuePath` afterwards, so the redirect never reaches the buffer:
// the batch rail writes
// `<cwd>/data/publisher-queue.buffer.jsonl` into the working tree, untracked
// and RELOADS it on the next run, so a previous run's rounds
// arrive in this one and fail their signing round. Re-deriving it from the venue's own redirected
// queuePath puts it in the temp directory the venue already removes in
// teardown, and dropping what start() loaded from the stale file keeps last
// run's rounds out of this one.
function preparePublishers() {
    for (const pub of venue.publishers) {
        if (pub.queuePath) pub.bufferPath = String(pub.queuePath).replace(/\.jsonl$/, '') + '.buffer.jsonl';
        if (pub._buffer && typeof pub._buffer.clear === 'function') pub._buffer.clear();
    }

    // Give every hub a STARTED batch-signing round.
    //
    // The venue attaches an OracleConsensus and an OraclePublisher per hub, both
    // of which predate PRICE v0, and nothing attaches an OracleBatchSigner.
    // `OraclePublisher._getBatchSigner` lazily builds and starts one for itself,
    // but only the LEADER ever reaches that call: a follower returns at the
    // "not our window" branch long before it, so no follower has the XPRICEB
    // message handler registered, no follower answers XPRICEB_SIGN_REQ, the
    // leader's signing round times out and the window never publishes. Wiring
    // them here is additive and touches nothing the venue owns.
    const OracleBatchSigner = loadHubModule('src/oracle/batch_signer.js');
    for (const hub of venue.mvh.hubs) {
        if (hub.oracleBatchSigner) continue;
        hub.oracleBatchSigner = new OracleBatchSigner(hub);
        hub.oracleBatchSigner.start();
    }
}

async function publishRounds(context) {
    rounds = await venue.finalizeRounds(ROUNDS);
    for (const r of rounds) for (const p of r.prices) expectedPairs.push({ round: r.round, coinPair: p.coinPair });

    // The block the last publish landed in, read from the NODE rather than from
    // an indexer, so the replay target is evidence about the chain.
    for (const pub of venue.publications) {
        const block = await venue.blockOf(pub.txid);
        if (block && (targetHeight === null || block.height > targetHeight)) targetHeight = block.height;
    }
    if (targetHeight === null) {
        await skipUnavailable(context, 'no publish reached a block on the landing chain');
        return;
    }

    wireVersions = [...new Set(venue.publications.map((p) => p.wireVersion))];
    venuePublicationBytes = venue.publications.map((p) => p.wireBytes);
    console.log('  AT2: federation published ' + venue.publications.length + ' PRICE transaction(s) ' +
        '(wire version ' + wireVersions.join('/') + '); last landed in block ' + targetHeight);
}

// --- 3. the live node absorbs them, then the federation goes away ---
async function collectLiveState() {
    await liveNode.waitForHeight(targetHeight);
    // The reconstruction is asynchronous relative to the block loop (the push
    // outbox delivers post-commit), so wait for the node's own outbox to empty
    // and then let the mirror settle. A quiet failure to reconstruct still reads
    // as zero, and an outbox that never drains still reports its rows.
    await liveNode.waitForPushDrain();
    await new Promise((r) => setTimeout(r, 15_000));

    liveSnaps  = await liveNode.hubPriceSnapshots({ rounds: rounds.map((r) => r.round) });
    livePrices = await liveNode.priceActions({ rounds: rounds.map((r) => r.round) });

    await venue.down();
    venue = null;
    for (const k of Object.keys(savedBatchEnv)) {
        if (savedBatchEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedBatchEnv[k];
    }
    savedBatchEnv = null;
}

// --- 4. the replay node, built from nothing, reads the whole chain ---
async function collectReplayState(context) {
    replayNode = new OracleBatchReplayNode({
        label: 'replay', hubDb: hubDb, basePort: 61100, priceGraceS: PRICE_GRACE_S });
    let up = false;
    try { up = await replayNode.up(); }
    catch (err) { await skipUnavailable(context, 'replay node failed to build: ' + (err && err.message)); return; }
    if (!up) { await skipUnavailable(context, replayNode.unavailable); return; }
    replayIsolation = await replayNode.isolationEvidence();

    console.log('  AT2: replay node built; replaying the chain to block ' + targetHeight + '...');
    await replayNode.waitForHeight(targetHeight);
    await replayNode.waitForPushDrain();
    await new Promise((r) => setTimeout(r, 15_000));

    replaySnaps   = await replayNode.hubPriceSnapshots({ rounds: rounds.map((r) => r.round) });
    replayMirror  = await replayNode.mirrorPriceSnapshots({ rounds: rounds.map((r) => r.round) });
    replayPrices  = await replayNode.priceActions({ rounds: rounds.map((r) => r.round) });
}

// --- 5. compare ---
async function compareState() {
    snapDiff = diffSnapshots(liveSnaps, replaySnaps);
    liveVerdicts   = await liveNode.actionVerdicts({ maxBlock: targetHeight });
    replayVerdicts = await replayNode.actionVerdicts({ maxBlock: targetHeight });
    verdictDiff    = diffVerdicts(liveVerdicts, replayVerdicts);
    // Which actions carry a fee is settled by the STANDING node, which has a
    // complete price history; see readFeeCoordinates for why neither side of
    // the comparison can be asked that about itself.
    feeCoordinates = await liveNode.liveChainFeeCoordinates({ maxBlock: targetHeight });
    feeVerdictDiff = diffVerdicts(liveVerdicts, replayVerdicts, { feeCoordinates: feeCoordinates });
    livePushQueue   = await liveNode.hubPushQueue();
    replayPushQueue = await replayNode.hubPushQueue();
}

// The run's evidence, printed once. A green tick with no numbers proves
// nothing to an operator reading CI, and a red one with no numbers proves
// less.
function logEvidence() {
    console.log('\n  --- AT2: what the two nodes actually hold ---');
    console.log('  federation finalized      : ' + rounds.length + ' round(s), ' + expectedPairs.length + ' round/pair snapshot(s)');
    console.log('  PRICE wire version(s)     : ' + wireVersions.join(', ') +
        ' over ' + venuePublicationBytes.join(', ') + ' byte(s)');
    console.log('  replay target block       : ' + targetHeight);
    console.log('  live node   isolation     : ' + JSON.stringify(liveIsolation));
    console.log('  replay node isolation     : ' + JSON.stringify(replayIsolation));
    // The Bitcoin oracle each node judged with, named with the height it was
    // actually asked at. Chain-only reconstruction is scoped to a node that has
    // one, so a run that does not say which one it used has not made the claim.
    console.log('  live   BTC cap. oracle    : ' + JSON.stringify(liveNode.btcOracleEvidence()));
    console.log('  replay BTC cap. oracle    : ' + JSON.stringify(replayNode.btcOracleEvidence()));
    console.log('  live node   PRICE actions : ' + livePrices.length + ' -> ' + describeHistogram(histogram(livePrices, 'status')));
    console.log('  replay node PRICE actions : ' + replayPrices.length + ' -> ' + describeHistogram(histogram(replayPrices, 'status')));
    console.log('  live node   snapshots     : ' + liveSnaps.length);
    console.log('  replay node snapshots     : ' + replaySnaps.length + ' (mirror carried down ' + replayMirror.length + ')');
    console.log('  snapshot diff             : ' + snapDiff.matched.length + ' matched, ' +
        snapDiff.missing.length + ' missing, ' + snapDiff.mismatched.length + ' mismatched, ' + snapDiff.extra.length + ' extra');
    console.log('  action verdicts compared  : ' + verdictDiff.compared + ', agreed ' + verdictDiff.agreed +
        ', disagreed ' + verdictDiff.disagreed.length + ', missing ' + verdictDiff.missing.length +
        ', extra ' + verdictDiff.extra.length);
    // WHAT the agreed fee verdicts actually were, not just that they agreed. Two
    // nodes that both reject every fee also "agree", and the difference between
    // that and two nodes that both accept every fee is the whole value of this
    // half of AT2.
    feeStatuses = (map) => {
        const h = {};
        for (const [key, v] of map) {
            if (!feeCoordinates.has(key.slice(key.indexOf('@') + 1))) continue;
            h[v.status] = (h[v.status] || 0) + 1;
        }
        return h;
    };
    console.log('  fee destination           : ' + liveNode.feeDestination());
    console.log('  fee-bearing coordinates   : ' + feeCoordinates.size + ' (from the standing node)');
    console.log('  fee-bearing verdicts      : ' + feeVerdictDiff.compared + ', agreed ' + feeVerdictDiff.agreed +
        ', disagreed ' + feeVerdictDiff.disagreed.length + ', missing ' + feeVerdictDiff.missing.length);
    if (verdictDiff.disagreed.length > 0) {
        for (const d of verdictDiff.disagreed.slice(0, 20)) {
            console.log('    DISAGREE ' + d.action + ' @' + d.blockIndex + '  live "' + d.live + '"  replay "' + d.replay + '"');
        }
    }
    console.log('  live   fee verdicts       : ' + describeHistogram(feeStatuses(liveVerdicts)));
    console.log('  replay fee verdicts       : ' + describeHistogram(feeStatuses(replayVerdicts)));
    console.log('  live push queue           : ' + JSON.stringify(livePushQueue));
    console.log('  replay push queue         : ' + JSON.stringify(replayPushQueue));
    console.log('  ---------------------------------------------\n');
}

async function setup() {
    await startLiveNode(this);
    await startVenue(this);
    preparePublishers();
    await publishRounds(this);
    await collectLiveState();
    await collectReplayState(this);
    await compareState();
    logEvidence();
}

async function teardown() {
        if (venue)      await venue.down();
        if (replayNode) await replayNode.down();
        if (liveNode)   await liveNode.down();
        if (hubDb)      await hubDb.stop();
    }

const sharedSuite = describe(
    'AT2: a fresh indexer with its own empty hub and no peers rebuilds price history from the chain alone (L3)',
    function () {
        this.timeout(90 * 60 * 1000);
        before(async function () { await setup.call(this); });
        after(teardown);
    }
);

function addTest(title, callback, file) {
    const test = new (require('mocha').Test)(title, callback);
    test.file = file;
    sharedSuite.addTest(test);
}

module.exports = {
    state, setup, teardown, addTest, histogram, describeHistogram,
    CAPABILITY_GAP_STATUS, SNAPSHOT_COMPARE_KEYS, assert
};
