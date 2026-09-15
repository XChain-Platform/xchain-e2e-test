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
 ********************************************************************/

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { OracleBatchVenue } = require('../helpers/oracleBatchVenue');
const { waitFor } = require('../helpers/consensusWait');
const oracle = require('./oracleBatchQuorum.integration.test/helpers/oracle_batch');
const oracleParts = require('./oracleBatchQuorum.integration.test/helpers/fixture');
const {
    drive, WINDOW_ROUNDS, VALIDATORS, MIN_SIGNATURES, GRACE_MS,
    SIGN_TIMEOUT_MS, QUIET_MS, KNOWN_CAPABILITY_GAP_STATUS,
    parseBatchWire, predictWindowLeader, sum, sha256,
} = oracle;

// Six PBFT rounds, two signing rounds (one of which is spent expiring), a
// publisher restart with its catch-up grace, an encoder build, a broadcast and a
// confirmation on a real chain. The budget is per-suite; every wait inside is a
// poll that returns the moment its condition holds.
const SUITE_TITLE = 'AT6 oracle batch signing round: quorum withheld, then the SAME window republished (L3)';

let venue = null, pinned = null, signerSet = null, tmpDir = null;
let savedQueuePath;

let roundBase = null, windowIndex = null, windowFirst = null, windowLast = null;
let predicted = null, silencedIndexes = [];
let baseline = null;

let rounds = [];
let phase1 = null, timeoutSeen = null, denied = null;
let leaderIndex = -1;
let nextWindowRound = null, restarted = false;
let settle = null, attempts = [], parsed = null;
let indexed = null, indexError = null, block = null;
let target = -1;

// Every borrowed piece of process state this file touches, given back. Called
// from after() and from the two skip paths in before(), because a suite that
// skips must not leave ORACLE_BATCH_GRACE_MS or PUBLISHER_QUEUE_PATH pinned for
// whatever mocha loads next. Every step is idempotent, so calling it twice is
// safe and cheaper than reasoning about which hook ran.
function releaseProcessState() {
    if (pinned) pinned.restore();
    if (savedQueuePath === undefined) delete process.env.PUBLISHER_QUEUE_PATH;
    else process.env.PUBLISHER_QUEUE_PATH = savedQueuePath;
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* teardown */ } }
}

// Pinned BEFORE the venue: OraclePublisher reads PUBLISHER_QUEUE_PATH,
// ORACLE_BATCH_WINDOW_ROUNDS and ORACLE_BATCH_GRACE_MS in its CONSTRUCTOR, so a
// value set after venue.up() is read by nobody. See the header on why the
// buffer path in particular has to move before the hubs start.
async function createOracleVenue() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-at6-quorum-'));
    savedQueuePath = process.env.PUBLISHER_QUEUE_PATH;
    process.env.PUBLISHER_QUEUE_PATH = path.join(tmpDir, 'publisher-queue.jsonl');
    pinned = drive.pinBatchWindow({ windowRounds: WINDOW_ROUNDS, graceMs: GRACE_MS });

    roundBase   = drive.alignedRoundBase(WINDOW_ROUNDS);
    windowIndex = Math.floor(roundBase / WINDOW_ROUNDS);
    windowFirst = windowIndex * WINDOW_ROUNDS;
    windowLast  = windowFirst + WINDOW_ROUNDS - 1;

    venue = new OracleBatchVenue({
        coin: 'dogecoin', network: 'regtest',
        validatorCount: VALIDATORS,
        basePort: 33960,
        roundBase: roundBase,
        expectWireVersion: 0
    });

    let up = false;
    try { up = await venue.up(); }
    catch (err) {
        console.log('AT6 venue unavailable: ' + (err && err.message));
        await venue.down(); venue = null; releaseProcessState();
        return false;
    }
    if (!up) {
        console.log('AT6 venue unavailable: ' + venue.unavailable);
        await venue.down(); venue = null; releaseProcessState();
        return false;
    }

    // One buffer file per hub. The env pin above already moved them out of the
    // checkout and off any previous run's rounds; this splits the four hubs apart
    // so one hub's observed-window prune cannot rewrite another's durable copy of
    // the window this drill is about to withhold and then recover. Safe to set
    // here: every publisher has already hydrated an EMPTY buffer, so nothing is
    // stranded at the old path and no catch-up timer was armed.
    for (let i = 0; i < venue.publishers.length; i++) {
        venue.publishers[i].bufferPath = path.join(tmpDir, 'publisher-buffer-' + i + '.jsonl');
    }

    // Every hub, not just the leader: OraclePublisher creates a signer lazily and
    // only the leader reaches that code, so without this no FOLLOWER has registered
    // the XPRICEB handler and BOTH attempts would expire short, which would make the
    // drill's second half prove nothing.
    signerSet = drive.attachBatchSigners(venue, { signTimeoutMs: SIGN_TIMEOUT_MS });

    predicted = await predictWindowLeader(venue, windowIndex, venue.anchorHeight);
    silencedIndexes = [];
    for (let i = 0; i < venue.mvh.hubs.length; i++) if (i !== predicted.index) silencedIndexes.push(i);
    signerSet.silence(silencedIndexes);

    baseline = signerSet.stats();

    return true;
}

async function withholdOracleQuorum() {
    // ---- PHASE 1: the window closes with the federation below signing quorum ----

    rounds = await drive.finalizeRoundsNoWait(venue, WINDOW_ROUNDS);

    // The event this phase exists to observe. Polled on the counter rather than
    // slept out, so a run that times out early or late is still read correctly.
    const baseTimeouts = sum(baseline, 'batchSignTimeouts');
    timeoutSeen = await waitFor(async () => {
        const stats = signerSet.stats();
        const total = sum(stats, 'batchSignTimeouts');
        return { ok: total > baseTimeouts, total: total, rounds: sum(stats, 'batchSignRounds') };
    }, { timeoutMs: 240_000, intervalMs: 500 });

    // Nothing may publish, and it must STAY nothing: an assertion taken the instant
    // the timeout fired would pass on a rail that published a second later.
    denied = await drive.waitForPublications(venue, { min: 0, quietMs: QUIET_MS, timeoutMs: 120_000 });

    phase1 = {
        pubStats:     venue.publisherStats(),
        sigStats:     signerSet.stats(),
        publications: venue.publications.slice(),
        proposals:    signerSet.proposals.slice()
    };
    leaderIndex = phase1.pubStats.findIndex((s) => s.isLeader === true);

    console.log('\n  --- AT6 phase 1: quorum withheld at window close ---');
    console.log('  window ' + windowIndex + ' = rounds [' + windowFirst + '..' + windowLast + ']');
    console.log('  rounds driven: ' + rounds.map((r) => r.round).join(', '));
    console.log('  predicted leader: hub ' + predicted.index + ' (rank ' + predicted.rank + ' of ' +
        predicted.publisherCount + ')   observed leader: hub ' + leaderIndex);
    console.log('  silenced signers: [' + silencedIndexes.join(', ') + ']');
    console.log('  timeout observed: ' + timeoutSeen.ok + ' after ' + timeoutSeen.waitedMs + 'ms');
    console.log('  publications: ' + phase1.publications.length);
    console.log(drive.railDiagnosis(venue, signerSet));
}

async function restoreOracleQuorum() {

    // ---- PHASE 2: quorum restored, the SAME window re-proposed ----

    // Put every silenced peer back on the mesh FIRST, so the re-proposal meets a
    // federation that can actually answer it.
    signerSet.unsilence(silencedIndexes);

    // One round into the NEXT window. This is the precondition the shipped
    // restart catch-up requires, not a nudge: `scheduleBufferCatchup` re-queues
    // every buffered window EXCEPT the newest, on the reasoning that the newest may
    // still be open. With only window W buffered, W IS the newest and the catch-up
    // would correctly leave it alone. Round `windowFirst + WINDOW_ROUNDS` is the
    // FIRST slot of W+1, so it arms no timer of its own and W+1 never assembles;
    // all it does is make W provably closed.
    nextWindowRound = await drive.finalizeRoundNoWait(venue, WINDOW_ROUNDS);

    target = leaderIndex >= 0 ? leaderIndex : predicted.index;
    if (target >= 0) {
        const leaderPub = venue.publishers[target];
        // The shipped later-attempt path, whole: stop releases the window timers,
        // start re-hydrates the buffer from the durable file and arms the catch-up
        // sweep. `stop()` does not touch a hub-wired OracleBatchSigner (it owns only
        // one it created itself), so the signer wrapping that captures the canonical
        // survives the restart and BOTH attempts are recorded by the same instance.
        leaderPub.stop();
        await leaderPub.start();
        restarted = true;
        settle = await drive.waitForPublications(venue, { min: 1, quietMs: QUIET_MS, timeoutMs: 420_000 });
    } else {
        settle = { reached: false, settled: false, count: venue.publications.length };
    }

    attempts = signerSet.proposals.filter((p) => p.first === windowFirst && p.last === windowLast);

    if (venue.publications.length > 0) {
        parsed = parseBatchWire(venue.publications[0].wire);
        block  = await venue.blockOf(venue.publications[0].txid);
        try { indexed = await venue.readIndexedPrice(venue.publications[0].txid); }
        catch (e) { indexError = e && e.message; }
    }
}

function printOracleReadout() {

    console.log('\n  --- AT6 phase 2: quorum restored, same window re-proposed ---');
    console.log('  extra round into window ' + (windowIndex + 1) + ': ' +
        (nextWindowRound ? nextWindowRound.round : '<none>'));
    console.log('  leader publisher restarted: ' + restarted + ' (hub ' + target + ')');
    console.log('  publications: ' + venue.publications.length);
    for (const p of venue.publications) {
        console.log('    leader hub ' + p.hubIndex + '  v' + p.wireVersion + '  wire ' + p.wireBytes +
            'B  ' + p.encoding + '  tx ' + p.txid);
    }
    for (let i = 0; i < attempts.length; i++) {
        const a = attempts[i];
        console.log('    attempt ' + (i + 1) + ': hub ' + a.hubIndex + '  [' + a.first + '..' + a.last +
            '] anchor ' + a.anchor + '  met=' + a.met + '  sigs=' + a.sigCount +
            '  canonical ' + (a.canonical ? Buffer.byteLength(a.canonical, 'utf8') + 'B sha256 ' +
                sha256(a.canonical).slice(0, 16) : '<none>'));
    }
    if (parsed && parsed.ok) {
        console.log('  wire: rounds [' + parsed.firstRound + '..' + parsed.lastRound + '] count ' +
            parsed.roundCount + '  sigs ' + parsed.sigs.length + '  anchor ' + parsed.anchor +
            '  body ' + parsed.bodyBytes + 'B  compressed=' + parsed.compressed);
    }
    if (indexed) {
        console.log('  indexed: action ' + indexed.action_index + '  version ' + indexed.version +
            '  batch [' + indexed.batch_first_round + '..' + indexed.batch_last_round + '] count ' +
            indexed.round_count + '  block ' + (block ? block.height : '?') + '  -> ' + indexed.status);
    } else if (indexError) {
        console.log('  indexed: NOT READ (' + indexError + ')');
    }
    console.log(drive.railDiagnosis(venue, signerSet));
}

async function setUpOracleBatch() {
    if (!(await createOracleVenue())) return false;
    await withholdOracleQuorum();
    await restoreOracleQuorum();
    printOracleReadout();
    return true;
}

async function tearDownOracleBatch() {
    if (signerSet) signerSet.stop();
    // The venue's own down() clears each publisher's broadcast hook but never calls
    // stop(), which predates the batch rail's timers; released here so no window or
    // catch-up timer outlives the suite.
    if (venue) for (const pub of venue.publishers) { try { pub.stop(); } catch (e) { /* teardown */ } }
    if (venue) await venue.down();
    releaseProcessState();
}

oracleParts.provide({
    setup: setUpOracleBatch,
    teardown: tearDownOracleBatch,
    snapshot: () => ({ venue, pinned, signerSet, roundBase, windowIndex, windowFirst, windowLast,
        predicted, silencedIndexes, baseline, rounds, phase1, timeoutSeen, denied, leaderIndex,
        nextWindowRound, restarted, settle, attempts, parsed, indexed, indexError, block }),
});

function registerOracleTest(title, callback) {
    describe(SUITE_TITLE, function () {
        this.timeout(60 * 60 * 1000);
        oracleParts.install();
        it(title, callback);
    });
}

registerOracleTest('the six rounds of the window finalized on a real multi-signature quorum', function () {
    assert.strictEqual(rounds.length, WINDOW_ROUNDS,
        'expected ' + WINDOW_ROUNDS + ' finalized rounds, got ' + rounds.length);
    for (const r of rounds) {
        const distinct = new Set(r.signatures.map((s) => String(s.pubkey).toLowerCase()));
        assert.ok(distinct.size >= MIN_SIGNATURES,
            'CONSENSUS rung: round ' + r.round + ' finalized on only ' + distinct.size +
            ' distinct signer(s); a weighted quorum over ' + VALIDATORS + ' equal sources needs ' +
            MIN_SIGNATURES + '. Silencing the batch signers must not have touched the PBFT rail, ' +
            'and if it did, nothing below this line can be read.' + drive.railDiagnosis(venue, signerSet));
    }
    assert.deepStrictEqual(rounds.map((r) => r.round),
        Array.from({ length: WINDOW_ROUNDS }, (_, i) => windowFirst + i),
        'the drill drove rounds outside window ' + windowIndex + ', so the window it withheld and the ' +
        'window it re-proposed are not the same window');
});

registerOracleTest('the drill silenced the hub set the publishers themselves elected against', function () {
    assert.ok(predicted.index >= 0,
        'no oracle_publish snapshot resolved, so the drill could not tell which hub would lead ' +
        'window ' + windowIndex + ' and its quorum denial would have been aimed at nobody');
    const leaders = phase1.pubStats
        .map((s, i) => ({ i: i, isLeader: s.isLeader, leaderRounds: s.leaderRounds }))
        .filter((s) => s.isLeader === true);
    assert.strictEqual(leaders.length, 1,
        'SCHEDULER rung: ' + leaders.length + ' hub(s) reported themselves leader of window ' +
        windowIndex + '; exactly one must, or the window was assembled by nobody or by everybody.' +
        drive.railDiagnosis(venue, signerSet));
    assert.strictEqual(leaderIndex, predicted.index,
        'the drill silenced every hub except ' + predicted.index + ' on the model that the leader of ' +
        'window ' + windowIndex + ' is windowIndex % publisherCount over the sorted oracle_publish ' +
        'snapshot, but hub ' + leaderIndex + ' actually led it. Quorum was still denied (the real ' +
        'leader was among the silenced), so phase 1 stands, but the drill\'s election model is wrong.');
});

registerOracleTest('with quorum withheld, the window published NOTHING and no fee was spent', function () {
    assert.strictEqual(phase1.publications.length, 0,
        'AT6 requires ZERO transactions for a window that never reached signing quorum; the ' +
        'federation emitted ' + phase1.publications.length + '. A wire published on a short signature ' +
        'set is a DOGE fee spent on an action every indexer refuses.' +
        drive.railDiagnosis(venue, signerSet));
    assert.ok(denied.settled,
        'the publication list was still moving when the quiet window expired, so "nothing published" ' +
        'is a race this run happened to win rather than a property.');
    for (let i = 0; i < phase1.pubStats.length; i++) {
        assert.strictEqual(phase1.pubStats[i].batchWindowsPublished, 0,
            'hub ' + i + ' counted ' + phase1.pubStats[i].batchWindowsPublished + ' published window(s) ' +
            'while quorum was withheld');
        assert.strictEqual(phase1.pubStats[i].lastPublishedWindow, null,
            'hub ' + i + ' recorded lastPublishedWindow ' + phase1.pubStats[i].lastPublishedWindow +
            ' for a window that never reached the wire');
    }
    // The rounds are still held, which is the whole basis of the recovery half.
    assert.ok(leaderIndex >= 0,
        'SCHEDULER rung: no hub reported itself leader of window ' + windowIndex + ', so the window ' +
        'was never assembled by anyone and "nothing published" is not evidence about quorum.' +
        drive.railDiagnosis(venue, signerSet));
    assert.ok(phase1.pubStats[leaderIndex].batchBufferDepth >= WINDOW_ROUNDS,
        'the leader buffered only ' + phase1.pubStats[leaderIndex].batchBufferDepth + ' round(s) after ' +
        'the withheld window; a failed signing round must not drop the rounds, or the hour of price ' +
        'data is gone and no later attempt can re-propose it');
});

registerOracleTest('the leader ran a signing round, it EXPIRED SHORT, and batchSignTimeouts moved', function () {
    assert.ok(timeoutSeen.ok,
        'SIGNING ROUND rung: no hub\'s batchSignTimeouts ever moved within ' + timeoutSeen.waitedMs +
        'ms. signRounds 0 means the leader never proposed at all (leader election or the window ' +
        'self-check), which is a different failure from the one AT6 measures.' +
        drive.railDiagnosis(venue, signerSet));

    assert.ok(leaderIndex >= 0,
        'SCHEDULER rung: no hub reported itself leader of window ' + windowIndex + ', so there is no ' +
        'hub whose signing round AT6 can read a timeout off.' + drive.railDiagnosis(venue, signerSet));
    const before = baseline[leaderIndex];
    const after  = phase1.sigStats[leaderIndex];
    assert.ok(after.batchSignRounds - before.batchSignRounds >= 1,
        'the elected leader (hub ' + leaderIndex + ') never opened a signing round, so nothing timed ' +
        'out; batchSignRounds went ' + before.batchSignRounds + ' -> ' + after.batchSignRounds);
    assert.strictEqual(after.batchSignTimeouts - before.batchSignTimeouts, 1,
        'AT6 names ONE expired round for the withheld window; hub ' + leaderIndex + '\'s ' +
        'batchSignTimeouts moved ' + before.batchSignTimeouts + ' -> ' + after.batchSignTimeouts);
    assert.strictEqual(after.batchSignQuorums - before.batchSignQuorums, 0,
        'hub ' + leaderIndex + ' reached quorum ' + (after.batchSignQuorums - before.batchSignQuorums) +
        ' time(s) while every peer signer was stopped, which means the round was satisfied by ' +
        'something other than peer signatures and the denial proved nothing');

    // The counter AT6 and spec section 7 actually name is the PUBLISHER's, which
    // surfaces the signer's. Asserted separately: an operator alerting on the
    // publisher stat must see the stall even though the signer owns the number.
    assert.strictEqual(phase1.pubStats[leaderIndex].batchSignTimeouts, after.batchSignTimeouts,
        'OraclePublisher.getStats() surfaced batchSignTimeouts ' +
        phase1.pubStats[leaderIndex].batchSignTimeouts + ' while its own signer counted ' +
        after.batchSignTimeouts + '; the stall is invisible to anything reading the publisher');
    assert.ok(phase1.pubStats[leaderIndex].batchSignTimeouts >= 1,
        'the publisher-surfaced batchSignTimeouts is ' + phase1.pubStats[leaderIndex].batchSignTimeouts);

    // Nobody REFUSED: the peers were absent, not disagreeing. This separates the
    // rung AT6 is about (quorum unavailable) from the rung AT4 is about (peers
    // present and unable to reproduce the bytes).
    assert.strictEqual(sum(phase1.sigStats, 'batchSignRefusals') - sum(baseline, 'batchSignRefusals'), 0,
        'a peer REFUSED the proposal rather than being absent for it; AT6 measures an unavailable ' +
        'quorum, and a refusal means the canonical itself was rejected, which is a different defect.' +
        drive.railDiagnosis(venue, signerSet));
    assert.strictEqual(sum(phase1.sigStats, 'batchSignaturesProvided') - sum(baseline, 'batchSignaturesProvided'), 0,
        'a silenced peer co-signed anyway, so the federation was never below signing quorum and the ' +
        'timeout this drill observed was caused by something else');
});
