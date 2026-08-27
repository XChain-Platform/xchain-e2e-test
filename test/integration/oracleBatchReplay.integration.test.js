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
 * THE CLAIM UNDER TEST is the one the whole PRICE v2 spec rests on: the chain
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
 * WHAT BLOCKS THIS TODAY, measured and not inferred. On any non-BTC chain the
 * indexer resolves the `price` capability set from its own `stakes` table, and
 * capability staking is BTC-only (`CAPABILITIES: {}` in
 * xchain-indexer/src/coins/DOGE.js); the hub-mirrored `capability_snapshots`
 * fallback covers only `cross_chain` and `oracle_publish`. Every PRICE landing
 * on DOGE therefore qualifies zero signers and records
 * `invalid: insufficient signer stake`, and an invalid PRICE pushes nothing, so
 * a replayed chain reconstructs NOTHING. That is a real gap in section 2's
 * chain-as-backup-of-last-resort, not a fault of this rig, and this suite is
 * built to say so precisely: when reconstruction is empty it names the verdict
 * every PRICE received and how many received it, rather than reporting a vague
 * mismatch. Nothing here is stubbed or skipped past to manufacture a pass, and
 * nothing needs editing when the capability gap closes: the same assertions turn
 * green on their own.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');

const { OracleBatchVenue }     = require('../helpers/oracleBatchVenue');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { loadHubModule }        = require('../helpers/multiValidatorHubHelper');
const {
    OracleBatchReplayNode,
    SNAPSHOT_COMPARE_KEYS,
    diffSnapshots,
    diffVerdicts
} = require('../helpers/oracleBatchReplay');

// Four validators, three rounds: the same shape the venue's own smoke drill
// uses, so a failure here is about replay and not about the publish rail.
const VALIDATORS = 4;
const ROUNDS     = 3;

// The one verdict a well-formed PRICE can legitimately receive on a non-BTC
// chain today besides an accept. Named as a constant so the failure message can
// quote it verbatim.
const CAPABILITY_GAP_STATUS = 'invalid: insufficient signer stake';

// The price-sync grace BOTH nodes run at, in seconds.
//
// MEASURED, and the reason this is not left at the frozen constant: at
// HUB_SYNC_WATERMARK_GRACE_S.price = 4800 a chain-only node replays the whole
// history in minutes and then stops at the first block younger than 4800
// seconds, deferring it once a minute until the hub's wall clock is 80 minutes
// past that block's time. Both nodes here read a freshly published block, so at
// the frozen value neither could reach the target inside any sensible budget.
// 600 is the value the platform ran on until this spec moved it, so it is a real
// barrier with real mirror-coverage semantics rather than a barrier switched off.
// It is applied IDENTICALLY to both nodes, which is what keeps the comparison
// sound; the indexer honours the override on regtest only. The drill that must
// exercise the barrier at 4800 is AT5, not this one.
const PRICE_GRACE_S = 600;

// Batch window knobs, set on the PROCESS before the venue builds its publishers
// (OraclePublisher reads them in its constructor) and restored afterwards.
//
// WHY A ONE-ROUND WINDOW. PRICE v2 has landed in the hub, PRICE_BATCH_ACTIVATION
// is genesis on regtest, and `onRoundFinalized` now buffers every finalized round
// instead of publishing it. The publish venue drives rounds one at a time and
// waits for each one to reach the chain, so at the shipped six-round window it
// waits forever and throws: the first five rounds of a window produce no
// transaction at all. A window of one makes every finalized round its own batch,
// which still puts a REAL `PRICE|2|` wire on the chain (the thing AT2 has to
// replay) while keeping the venue's one-round-at-a-time contract intact. Window
// COMPOSITION is AT1's question, not this suite's.
const BATCH_WINDOW_ROUNDS = 1;
// The window's post-close grace, shipped at 300000ms. Nothing arrives late in a
// one-round window, so the whole 5 minutes would be dead time per round.
const BATCH_GRACE_MS = 3000;

function histogram(rows, field) {
    const out = {};
    for (const r of rows) out[String(r[field])] = (out[String(r[field])] || 0) + 1;
    return out;
}

function describeHistogram(h) {
    return Object.keys(h).map((k) => h[k] + ' x "' + k + '"').join(', ') || 'nothing';
}

describe('AT2: a fresh indexer with its own empty hub and no peers rebuilds price history from the chain alone (L3)', function () {
    // Two whole nodes, two full chain replays and a live publish rail. The budget
    // is per-suite; every wait inside is a poll that returns the moment it can.
    this.timeout(90 * 60 * 1000);

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

    before(async function () {
        // Started here, once, and shared with everything below. The venue's own
        // startDisposableHubDb call resolves this same handle out of the
        // environment and returns a no-op stop(), so tearing the federation down
        // cannot take the replay node's database server with it.
        hubDb = await startDisposableHubDb();
        if (!hubDb) {
            console.log('AT2 unavailable: no env hub DB and Docker unavailable');
            this.skip();
            return;
        }

        const bail = async (why) => {
            console.log('AT2 unavailable: ' + why);
            if (venue) await venue.down();
            if (replayNode) await replayNode.down();
            if (liveNode) await liveNode.down();
            if (hubDb) await hubDb.stop();
            venue = replayNode = liveNode = hubDb = null;
        };

        // --- 1. the live node, up and caught up BEFORE anything is published ---
        liveNode = new OracleBatchReplayNode({
            label: 'live', hubDb: hubDb, basePort: 61000, priceGraceS: PRICE_GRACE_S });
        let up = false;
        try { up = await liveNode.up(); }
        catch (err) { await bail('live node failed to build: ' + (err && err.message)); this.skip(); return; }
        if (!up) { await bail(liveNode.unavailable); this.skip(); return; }
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

        // --- 2. the federation publishes onto the chain the nodes are reading ---
        savedBatchEnv = {
            ORACLE_BATCH_WINDOW_ROUNDS: process.env.ORACLE_BATCH_WINDOW_ROUNDS,
            ORACLE_BATCH_GRACE_MS:      process.env.ORACLE_BATCH_GRACE_MS
        };
        process.env.ORACLE_BATCH_WINDOW_ROUNDS = String(BATCH_WINDOW_ROUNDS);
        process.env.ORACLE_BATCH_GRACE_MS      = String(BATCH_GRACE_MS);

        venue = new OracleBatchVenue({
            coin: 'dogecoin', network: 'regtest',
            validatorCount: VALIDATORS, basePort: 33900, expectWireVersion: 2
        });
        let venueUp = false;
        try { venueUp = await venue.up(); }
        catch (err) { await bail('publish venue failed to build: ' + (err && err.message)); this.skip(); return; }
        if (!venueUp) { await bail(venue.unavailable); this.skip(); return; }

        // Keep the v2 batch BUFFER out of the checkout.
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
        for (const pub of venue.publishers) {
            if (pub.queuePath) pub.bufferPath = String(pub.queuePath).replace(/\.jsonl$/, '') + '.buffer.jsonl';
            if (pub._buffer && typeof pub._buffer.clear === 'function') pub._buffer.clear();
        }

        // Give every hub a STARTED batch-signing round.
        //
        // The venue attaches an OracleConsensus and an OraclePublisher per hub, both
        // of which predate PRICE v2, and nothing attaches an OracleBatchSigner.
        // `OraclePublisher._getBatchSigner` lazily builds and starts one for itself,
        // but only the LEADER ever reaches that call: a follower returns at the
        // "not our window" branch long before it, so no follower has the XPRICEB
        // message handler registered, no follower answers XPRICEB_SIGN_REQ, the
        // leader's signing round times out and the window never publishes. Wiring
        // them here is additive and touches nothing the venue owns.
        const OracleBatchSigner = loadHubModule('src/OracleBatchSigner.js');
        for (const hub of venue.mvh.hubs) {
            if (hub.oracleBatchSigner) continue;
            hub.oracleBatchSigner = new OracleBatchSigner(hub);
            hub.oracleBatchSigner.start();
        }

        rounds = await venue.finalizeRounds(ROUNDS);
        for (const r of rounds) for (const p of r.prices) expectedPairs.push({ round: r.round, coinPair: p.coinPair });

        // The block the last publish landed in, read from the NODE rather than from
        // an indexer, so the replay target is evidence about the chain.
        for (const pub of venue.publications) {
            const block = await venue.blockOf(pub.txid);
            if (block && (targetHeight === null || block.height > targetHeight)) targetHeight = block.height;
        }
        if (targetHeight === null) { await bail('no publish reached a block on the landing chain'); this.skip(); return; }

        wireVersions = [...new Set(venue.publications.map((p) => p.wireVersion))];
        venuePublicationBytes = venue.publications.map((p) => p.wireBytes);
        console.log('  AT2: federation published ' + venue.publications.length + ' PRICE transaction(s) ' +
            '(wire version ' + wireVersions.join('/') + '); last landed in block ' + targetHeight);

        // --- 3. the live node absorbs them, then the federation goes away ---
        await liveNode.waitForHeight(targetHeight);
        // The reconstruction is asynchronous relative to the block loop (the push
        // outbox delivers post-commit), so give the mirror a moment to settle
        // before reading. A quiet failure to reconstruct still reads as zero.
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

        // --- 4. the replay node, built from nothing, reads the whole chain ---
        replayNode = new OracleBatchReplayNode({
            label: 'replay', hubDb: hubDb, basePort: 61100, priceGraceS: PRICE_GRACE_S });
        try { up = await replayNode.up(); }
        catch (err) { await bail('replay node failed to build: ' + (err && err.message)); this.skip(); return; }
        if (!up) { await bail(replayNode.unavailable); this.skip(); return; }
        replayIsolation = await replayNode.isolationEvidence();

        console.log('  AT2: replay node built; replaying the chain to block ' + targetHeight + '...');
        await replayNode.waitForHeight(targetHeight);
        await new Promise((r) => setTimeout(r, 15_000));

        replaySnaps   = await replayNode.hubPriceSnapshots({ rounds: rounds.map((r) => r.round) });
        replayMirror  = await replayNode.mirrorPriceSnapshots({ rounds: rounds.map((r) => r.round) });
        replayPrices  = await replayNode.priceActions({ rounds: rounds.map((r) => r.round) });

        // --- 5. compare ---
        snapDiff = diffSnapshots(liveSnaps, replaySnaps);
        liveVerdicts   = await liveNode.actionVerdicts({ maxBlock: targetHeight });
        replayVerdicts = await replayNode.actionVerdicts({ maxBlock: targetHeight });
        verdictDiff    = diffVerdicts(liveVerdicts, replayVerdicts);
        // Which actions carry a fee is settled by the STANDING node, which has a
        // complete price history; see readFeeCoordinates for why neither side of
        // the comparison can be asked that about itself.
        feeCoordinates = await liveNode.liveChainFeeCoordinates({ maxBlock: targetHeight });
        feeVerdictDiff = diffVerdicts(liveVerdicts, replayVerdicts, { feeCoordinates: feeCoordinates });

        // The run's evidence, printed once. A green tick with no numbers proves
        // nothing to an operator reading CI, and a red one with no numbers proves
        // less.
        console.log('\n  --- AT2: what the two nodes actually hold ---');
        console.log('  federation finalized      : ' + rounds.length + ' round(s), ' + expectedPairs.length + ' round/pair snapshot(s)');
        console.log('  PRICE wire version(s)     : ' + wireVersions.join(', ') +
            ' over ' + venuePublicationBytes.join(', ') + ' byte(s)');
        console.log('  replay target block       : ' + targetHeight);
        console.log('  live node   isolation     : ' + JSON.stringify(liveIsolation));
        console.log('  replay node isolation     : ' + JSON.stringify(replayIsolation));
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
        livePushQueue   = await liveNode.hubPushQueue();
        replayPushQueue = await replayNode.hubPushQueue();
        console.log('  live push queue           : ' + JSON.stringify(livePushQueue));
        console.log('  replay push queue         : ' + JSON.stringify(replayPushQueue));
        console.log('  ---------------------------------------------\n');
    });

    after(async function () {
        if (venue)      await venue.down();
        if (replayNode) await replayNode.down();
        if (liveNode)   await liveNode.down();
        if (hubDb)      await hubDb.stop();
    });

    it('both nodes really were isolated: an empty hub, no validators, no peers', function () {
        for (const [name, ev] of [['live', liveIsolation], ['replay', replayIsolation]]) {
            assert.ok(ev, name + ' node produced no isolation evidence');
            assert.strictEqual(ev.p2pValidatorAddrSet, false,
                name + ' node was given a P2P validator address, so its hub would run consensus and an oracle round of ' +
                'its own; every snapshot it held would then be suspect');
            assert.strictEqual(ev.seedNodesSet, false, name + ' node was given seed nodes, so its hub had peers to learn from');
            assert.strictEqual(ev.hubSnapshotsAtBoot, 0,
                name + ' node\'s hub already held ' + ev.hubSnapshotsAtBoot + ' price snapshot(s) before a single block ' +
                'reached it; nothing it reconstructs afterwards can be attributed to the chain');
            assert.strictEqual(ev.hubValidators, 0,
                name + ' node\'s hub already knew ' + ev.hubValidators + ' validator(s); it was not built from nothing');
        }
    });

    it('the live node reconstructed a price snapshot for every round the federation put on the chain', function () {
        const expected = expectedPairs.length;
        if (liveSnaps.length === expected) return;

        // WHICH RUNG IS BLOCKING, named rather than described. A replayed chain can
        // only rebuild what a live chain accepted, and the path from a landed wire to
        // a mirrored snapshot has four rungs. Walking them in order turns "AT2 is
        // still red" into a statement the next session can read as progress or as a
        // regression, which matters while the `price` capability fix is only
        // partially landed (the resolver consults the mirrored snapshot behind a
        // gate, but the parser does not yet pass the block time, still resolves at
        // the LANDING chain's height instead of the Bitcoin anchor, and the hub never
        // persists a price snapshot for the mirror to serve).
        const byStatus = histogram(livePrices, 'status');
        const gapCount = byStatus[CAPABILITY_GAP_STATUS] || 0;
        const valid    = byStatus['valid'] || 0;
        let rung;
        if (livePrices.length === 0) {
            rung = 'RUNG 1 (parse): the node indexed NO PRICE action at all for these rounds, so the ' +
                'wire never reached its parser. The publish landed in a block the node has, so this is a ' +
                'decode or action-registration failure, not a capability one';
        } else if (gapCount === livePrices.length) {
            rung = 'RUNG 2 (signer resolution): every one of the ' + livePrices.length + ' PRICE action(s) it ' +
                'indexed recorded "' + CAPABILITY_GAP_STATUS + '". The `price` capability set still resolves ' +
                'empty on this chain, so zero signers qualify and weighted quorum fails closed on S=0. This is ' +
                'the known gap: capability staking is BTC-only (xchain-indexer/src/coins/DOGE.js ' +
                'CAPABILITIES: {}) and the mirrored capability_snapshots fallback historically covered only ' +
                'cross_chain and oracle_publish. Check, in this order, whether the parser passes the block ' +
                'time to the gate, whether it resolves at the BITCOIN ANCHOR rather than at the landing ' +
                'chain\'s own height, and whether any hub is persisting a price capability snapshot for the ' +
                'mirror to serve at all';
        } else if (valid > 0) {
            rung = 'RUNG 3 (push): ' + valid + ' of the ' + livePrices.length + ' PRICE action(s) validated, ' +
                'so signer resolution is working, but the hub still holds no snapshot for them. The push is ' +
                'the suspect: its outbox reads ' + JSON.stringify(livePushQueue) + '. An empty outbox with ' +
                'valid actions means the push was made and the hub refused it (PriceAggregator rejects on an ' +
                'unresolvable validator snapshot, a duplicate, or a pair/price bound); a non-empty one means ' +
                'delivery never succeeded';
        } else {
            rung = 'RUNG 2 (signer resolution), mixed: the ' + livePrices.length + ' PRICE action(s) it ' +
                'indexed recorded: ' + describeHistogram(byStatus);
        }
        assert.fail('the live node rebuilt ' + liveSnaps.length + ' of the ' + expected + ' price_snapshots the ' +
            'federation finalized over ' + rounds.length + ' round(s). ' + rung);
    });

    it('the replay node rebuilt the same snapshots the live node did, on ' + SNAPSHOT_COMPARE_KEYS.join(', '), function () {
        assert.ok(snapDiff, 'the run produced no snapshot comparison');
        assert.strictEqual(snapDiff.missing.length, 0,
            'the replay node is missing ' + snapDiff.missing.length + ' snapshot(s) the live node holds: ' +
            snapDiff.missing.slice(0, 10).map((r) => r.round_number + '/' + r.coin_pair).join(', ') +
            '. The chain alone was not enough to rebuild them. Its PRICE verdicts were: ' +
            describeHistogram(histogram(replayPrices, 'status')));
        assert.strictEqual(snapDiff.mismatched.length, 0,
            'the replay node rebuilt ' + snapDiff.mismatched.length + ' snapshot(s) that differ from the live node: ' +
            snapDiff.mismatched.slice(0, 10).map((m) =>
                m.key + ' on ' + m.columns.map((c) => c + ' (live ' + m.live[c] + ' vs replay ' + m.replay[c] + ')').join(' and ')
            ).join('; '));
        assert.strictEqual(snapDiff.extra.length, 0,
            'the replay node holds ' + snapDiff.extra.length + ' snapshot(s) the live node does not, for rounds the ' +
            'federation finalized; a chain-only node must not invent history: ' +
            snapDiff.extra.slice(0, 10).map((r) => r.round_number + '/' + r.coin_pair).join(', '));
        assert.ok(snapDiff.matched.length > 0,
            'nothing was compared: neither node holds a snapshot for any of the ' + rounds.length +
            ' round(s) the federation finalized, so this assertion proved nothing');
    });

    it('the replay node\'s own indexer can read what its hub rebuilt', function () {
        // The reconstruction is only useful if it comes back DOWN the mirror into
        // the connection the settlement path actually reads.
        assert.strictEqual(replayMirror.length, replaySnaps.length,
            'the replay node\'s hub holds ' + replaySnaps.length + ' snapshot(s) but hub_db_sync carried ' +
            replayMirror.length + ' of them down into the mirror the indexer reads. A reconstruction the node ' +
            'cannot see is not a reconstruction.');
    });

    it('every fee-bearing action on the chain replays to the identical validity verdict', function () {
        assert.ok(feeVerdictDiff, 'the run produced no fee verdict comparison');
        assert.ok(feeVerdictDiff.compared > 0,
            'the standing chain records no fee-bearing action at or below block ' + targetHeight +
            ' (' + feeCoordinates.size + ' coordinate(s) found), so nothing was compared and this assertion ' +
            'proved nothing');
        assert.strictEqual(feeVerdictDiff.disagreed.length, 0,
            feeVerdictDiff.disagreed.length + ' of ' + feeVerdictDiff.compared + ' fee-bearing action(s) reached a ' +
            'DIFFERENT verdict on a node that replayed the chain than on the node that was live. Fee validation is ' +
            'supposed to be chain-time and not arrival-time (getLatestPrice selects on block_timestamp <= blockTime ' +
            'and applies staleness as blockTime - snapshot.block_timestamp, both chain-derived), so a node that ' +
            'waits must reach the verdict a node that was live reached. Divergences: ' +
            feeVerdictDiff.disagreed.slice(0, 15).map((d) =>
                d.action + ' @' + d.blockIndex + ' live "' + d.live + '" vs replay "' + d.replay + '"').join('; '));
        assert.strictEqual(feeVerdictDiff.missing.length, 0,
            feeVerdictDiff.missing.length + ' fee-bearing action(s) the live node recorded are absent from the ' +
            'replay node entirely, which is a bigger divergence than a differing verdict: ' +
            feeVerdictDiff.missing.slice(0, 10).map((m) => m.key).join(', '));

        // AGREEING ON NOTHING IS NOT THE PROPERTY. Two nodes that both failed every
        // fee for want of a price agree perfectly and demonstrate nothing, and that
        // is exactly the state the capability gap leaves them in: no PRICE validates,
        // no snapshot is rebuilt, and getLatestPrice then has nothing to value a fee
        // against on EITHER node. The identity above only means something once the
        // fees were actually priced, so say so rather than bank a vacuous green.
        const priceless = Object.keys(feeStatuses(liveVerdicts))
            .filter((s) => /no current oracle price/.test(s))
            .reduce((n, s) => n + feeStatuses(liveVerdicts)[s], 0);
        assert.strictEqual(priceless, 0,
            priceless + ' of the ' + feeVerdictDiff.compared + ' fee-bearing action(s) reached the SAME verdict on ' +
            'both nodes only because neither could price the fee at all ("no current oracle price for ...", the ' +
            'staleness guard with an empty price history behind it). That is the capability gap one step ' +
            'downstream: with no PRICE validating, no snapshot is rebuilt, and a fee has nothing to be valued ' +
            'against. The agreement is real but vacuous, and this assertion is what keeps it from reading as ' +
            'proof that fee validation is chain-time rather than arrival-time.');
    });

    it('every action on the chain, fee-bearing or not, replays to the identical verdict', function () {
        assert.ok(verdictDiff, 'the run produced no verdict comparison');
        assert.ok(verdictDiff.compared > 0, 'no action verdicts were compared at all');
        assert.strictEqual(verdictDiff.disagreed.length, 0,
            verdictDiff.disagreed.length + ' of ' + verdictDiff.compared + ' action(s) replayed to a different ' +
            'verdict: ' + verdictDiff.disagreed.slice(0, 15).map((d) =>
                d.action + ' @' + d.blockIndex + ' live "' + d.live + '" vs replay "' + d.replay + '"').join('; '));
        assert.strictEqual(verdictDiff.missing.length, 0,
            verdictDiff.missing.length + ' action(s) the live node recorded never appeared on the replay node: ' +
            verdictDiff.missing.slice(0, 10).map((m) => m.key).join(', '));
        assert.strictEqual(verdictDiff.extra.length, 0,
            verdictDiff.extra.length + ' action(s) exist on the replay node and not on the live one: ' +
            verdictDiff.extra.slice(0, 10).map((m) => m.key).join(', '));
    });
});
