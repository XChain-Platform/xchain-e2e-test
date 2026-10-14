/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');

const anchorVersions = require('../../helpers/anchorVersionHelper');
const { S, ROUND_TIMEOUT_MS } = require('./state');
const { signedCheckpoint, nextCheckpointSeq, insertCheckpointEverywhere, insertMatchEverywhere,
        archivePipeline, describePipeline } = require('./db');
const { busyArchiveRounds, waitForArchiveQuiescent, describeBusy, waitForArchiveHead } = require('./waits');
const { parseArchiveHead, electArchive, describeViews, electBundle } = require('./election');

// SETTLE FIRST, then seed this cycle's checkpoint and pending match everywhere.
async function seedCycle(label){
    // SETTLE FIRST. An archive round still in flight from an earlier cycle makes
    // this cycle's flush return 'round_pending' before it elects anything, and it
    // also means the batch seq every election below reads is one the in-flight
    // round is about to consume. On a federation's first cycle this returns
    // immediately; it is AT-F4's second cycle that needs it.
    const busy = await waitForArchiveQuiescent(ROUND_TIMEOUT_MS + 240000);
    assert.strictEqual(busy.length, 0,
        label + ': an archive round from an earlier cycle never settled (' + describeBusy(busy) + '). ' +
        'Flushing now would return round_pending and this cycle would be measuring the previous ' +
        'round rather than its own.');

    const seq = await nextCheckpointSeq('DOGE');
    const cp  = signedCheckpoint('DOGE', seq);
    await insertCheckpointEverywhere(cp);
    const matchId = crypto.createHash('sha256')
        .update('degraded-archive-' + label + '-' + Date.now()).digest('hex');
    await insertMatchEverywhere(matchId);
    return { seq, cp, matchId };
}

// WHO IS ELECTED, settled and asserted BEFORE anything flushes.
async function assertElection(label, seq){
    // WHO IS ELECTED, settled and asserted BEFORE anything flushes. A split here
    // fails naming both hubs' views; discovering it after the flush would surface
    // as a missing archive head, which reads like a publisher defect.
    const election = await electArchive();
    assert.ok(election.converged,
        label + ': the hubs do not agree on the archive election. Views: ' + describeViews(election.views) +
        '. getNextBatchSeq is MAX+1 over each hub\'s OWN tables, so unequal tables mean ' +
        'different election keys and each hub can be rank 0 for its own; that is a SPLIT, ' +
        'not a lag, and no wait converges it.');
    assert.strictEqual(Number(election.cpRow.checkpoint_seq), seq,
        label + ': the archive wrapper is this cycle\'s checkpoint');
    assert.ok(election.leader >= 0 && election.follower >= 0 && election.leader !== election.follower,
        label + ': the election resolved to one leader and one distinct co-signer (' +
        describeViews(election.views) + ')');
    assert.ok(election.views[election.leader].selfRankZero,
        label + ': hub' + election.leader + ' agrees it is rank 0 for batch ' + election.batchSeq +
        ' (' + describeViews(election.views) + ')');
    return election;
}

// Everything read or fired between the election and the flush: the bundle leader,
// the wire marks, the fault seam and the content precondition.
async function prepareFlush(label, opts, seq, election){
    const requireBundle = opts.requireBundle !== false;
    const bundleLeader = electBundle();
    const before       = S.broadcasts.length;
    const seenBefore   = S.archiveSignReqSeen.slice();
    console.log('    [' + label + '] cp seq ' + seq + ' / batch ' + election.batchSeq +
                ': archive leader hub' + election.leader + ' (self rank 0), co-signer hub' + election.follower +
                (requireBundle ? ', bundle leader hub' + bundleLeader : ', archive-only') +
                '; key ' + election.key);
    if (opts.onElected) await opts.onElected(election);

    // THE CONTENT PRECONDITION, checked on the hub that is about to publish and
    // as late as possible: an empty pipeline makes startArchiveRound answer
    // 'none' however clean the election is, and that is indistinguishable from an
    // election fault once the flush has returned.
    const pipeline = await archivePipeline(election.leader);
    assert.ok(pipeline.matches >= 1,
        label + ': hub' + election.leader + ' holds unarchived content to publish (' +
        describePipeline(pipeline) + '). All three empty means startArchiveRound returns "none" ' +
        'before it does anything else, so this cycle needs its own freshly seeded, unbatched row.');
    return { requireBundle, bundleLeader, before, seenBefore, pipeline };
}

// Bundle first when it is wanted, then the archive round.
async function flushLeaders(requireBundle, bundleLeader, election){
    // Bundle first when it is wanted (it publishes synchronously inside the
    // flush), then the archive round. One flush covers both when the two
    // elections agree on the same hub.
    const order = requireBundle
        ? ((bundleLeader === election.leader) ? [bundleLeader] : [bundleLeader, election.leader])
        : [election.leader];
    const summaries = {};
    for (const i of order) summaries[i] = await S.mvh.hubs[i].stateAnchorPublisher.flush();
    return summaries;
}

// The elected leader must have ACCEPTED the round.
function assertArchiveAccepted(label, election, summaries, pipeline){
    // The elected leader must have ACCEPTED the round. 'none' here is the exact
    // shape of the first live drive's failure: the flushed hub declined the
    // election, and the missing head minutes later was only the symptom.
    //
    // 'round_pending' is deliberately NOT accepted here. It means the guard at the
    // top of startArchiveRound refused because a round was already in flight, so
    // every assertion after this point would be reading the PREVIOUS cycle's head:
    // a green that measures something easier than it claims. The quiesce wait above
    // is the fix; seeing this verdict despite it means a round started in between.
    const archiveSummary = String(summaries[election.leader] && summaries[election.leader].archive);
    assert.ok(archiveSummary === 'round_started' || archiveSummary === 'published',
        label + ': the elected hub' + election.leader + ' started its archive round for batch ' +
        election.batchSeq + ' (flush said archive="' + archiveSummary + '"). ' +
        'A "round_pending" means an earlier round was still in flight despite the settle wait. ' +
        'A "none" is NOT the content gate here: the pipeline was checked non-empty immediately ' +
        'above (' + describePipeline(pipeline) + '), so look at the election set or the wrapper ' +
        'checkpoint instead. Views: ' + describeViews(election.views) +
        '; in flight now: ' + (describeBusy(busyArchiveRounds()) || 'nothing'));
}

// This cycle's v0 bundle (when wanted) and v1 archive head, off the wire.
async function collectWire(label, ctx, election, seq, cp){
    const { requireBundle, before } = ctx;
    const bundle = anchorVersions.bundleBroadcasts(S.broadcasts.slice(before))
        .find(b => b.bundle.sections.some(s => String(s.ledger_hash) === String(cp.ledger_hash)));
    if (requireBundle)
        assert.ok(bundle, label + ': the v0 bundle carrying this cycle\'s checkpoint went to the chain');

    // A degraded cycle waits out ROUND_TIMEOUT_MS on top of the mine/quiesce
    // legs, so the budget clears it with room rather than racing it.
    const headWire = await waitForArchiveHead(before, ROUND_TIMEOUT_MS + 240000);
    assert.ok(headWire, label + ': the v1 archive head went to the chain');
    const head = parseArchiveHead(headWire.payload);
    assert.strictEqual(head.batch_seq, election.batchSeq,
        label + ': the head carries the batch seq the election was keyed on');
    assert.strictEqual(head.checkpoint_seq, seq, label + ': the head wraps this cycle\'s checkpoint');
    assert.strictEqual(head.publisher, S.pubkeys[election.leader],
        label + ': the head names the elected leader as PUBLISHER');
    return { bundle, head, headWire };
}

// One publish cycle on the current federation: a fresh checkpoint and a fresh
// pending match on every hub, then a flush by the hubs that are elected to
// publish something.
//
// opts.onElected(election) fires AFTER the election and BEFORE any flush. The
// archive election key binds the wrapper checkpoint and the batch seq, both of
// which this cycle's own inserts move, so who the co-signer IS cannot be known
// any earlier. Injecting a fault from outside on a previous cycle's election
// would silence the wrong hub half the time.
//
// opts.requireBundle (default true) also flushes the elected BUNDLE publisher
// and asserts a v0 landed. AT-F4 turns it off: recovery is a claim about the
// archive tail, and flushing only the archive leader keeps exactly one hub
// publishing, which is the cleanest run the batch_seq back-fill can get.
async function runCycle(label, opts){
    opts = opts || {};
    const { seq, cp, matchId } = await seedCycle(label);
    const election = await assertElection(label, seq);
    const ctx = await prepareFlush(label, opts, seq, election);
    const summaries = await flushLeaders(ctx.requireBundle, ctx.bundleLeader, election);
    assertArchiveAccepted(label, election, summaries, ctx.pipeline);
    const { bundle, head, headWire } = await collectWire(label, ctx, election, seq, cp);
    return {
        label, cp, matchId, election, bundleLeader: ctx.bundleLeader, bundle, head, headWire, summaries,
        signReqDelta: S.archiveSignReqSeen.map((n, i) => n - ctx.seenBefore[i])
    };
}

module.exports = { runCycle };
