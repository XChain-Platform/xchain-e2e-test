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
 * AT6 (signing round): quorum unavailable at window close leaves the window
 * unpublished, increments `batchSignTimeouts`, and a later leader publishes the
 * same window with byte-identical canonical content.
 *
 * THE CLAIM THIS DRILL EXISTS FOR. The batch rail buys its cost saving by putting
 * an hour of price data under ONE quorum signature set, which means an hour of
 * price data is now hostage to one signing round. AT6 is the liveness half of
 * that bargain: a window that misses quorum must fail CLOSED (nothing on chain,
 * no fee spent, a counter moved) and must stay RECOVERABLE (a later attempt
 * re-proposes it and reaches the wire). A rail that failed closed but not
 * recoverable would lose an hour of price history to one bad minute; a rail that
 * was recoverable but did not fail closed would put a short signature set on
 * chain that every indexer refuses, and pay a DOGE fee for it.
 *
 * WHAT IS REAL. Six real PBFT price rounds on four in-process validators with a
 * real peer mesh; the real OraclePublisher window scheduler, buffer file, leader
 * election, self-check, packer and wire builder; two real OracleBatchSigner
 * rounds over the real P2P mesh; a real encoder build, signature and broadcast on
 * DOGE regtest; a real block; and the `prices` row read back out of the landing
 * chain's own indexer. Nothing is stubbed to manufacture either half: the first
 * signing round fails because no peer will answer it, and the second succeeds
 * because the same peers are back and can rebuild the same bytes.
 *
 * HOW QUORUM IS DENIED, and why this is the honest shape. The window's leader is
 * `windowIndex % publisherCount` over the sorted oracle_publish snapshot, which
 * is a pure function of the window, so this drill computes it BEFORE driving any
 * round and then stops the OracleBatchSigner on every OTHER hub. A stopped signer
 * has removed its `peerManager.on('message')` handler, so it never sees
 * XPRICEB_SIGN_REQ and never replies: the federation is genuinely below signing
 * quorum at the moment the window closes, with the leader itself fully healthy
 * and simply unanswered. Stopping the SIGNER rather than the hub is deliberate
 * and is what keeps the drill measuring one rung: OracleBatchSigner handles only
 * XPRICEB traffic, so the PBFT rounds, the price_snapshots writes and the mesh
 * are all untouched, and a red run cannot be blamed on a broken federation.
 * Four equal-weight validators need three signatures, so one is short by two.
 *
 * WHAT "A LATER LEADER" MEANS AT HEAD, stated plainly rather than glossed. Leader
 * election is `windowIndex % publisherCount`, so the leader of a given window is
 * FIXED, and followers memoize the window in `_assembledWindows`; the only hub
 * that can re-propose window W is the hub that led it, which the source comment
 * at the quorum-failure return names as "a later leader (or a later catch-up on
 * this hub)". So AT6's "later leader" is realized here as the shipped LATER
 * ATTEMPT: quorum is restored, one further round is finalized into the NEXT
 * window (which is what makes W a closed, non-newest buffered window), and the
 * leader's publisher is restarted. `start()`'s `_scheduleBufferCatchup()` then
 * re-queues exactly the windows a restart dropped, W among them. That path is
 * entirely shipped code: this file triggers it, it does not reimplement it and it
 * pokes no private memo to unstick the window. See the report for the gap.
 *
 * THE BYTE-IDENTITY ASSERTION IS TAKEN FROM THE SIGNER, NOT REBUILT HERE. D17
 * rules that split boundaries need NOT agree across leaders, so "the same batch"
 * is not a claim this drill may make about ranges in general; what D17 does bind,
 * and what AT6 names, is that a re-proposal of the SAME window produces
 * byte-identical canonical content. `oracleBatchDrive.attachBatchSigners` wraps
 * `_canonical` on each signer, so both attempts hand back the bytes the REAL
 * builder produced, and the comparison is between two runs of the producer rather
 * than between the producer and a test-side re-derivation of it.
 *
 * THE BUFFER PATH IS REDIRECTED HERE, and it is load-bearing. OraclePublisher
 * derives `bufferPath` from `queuePath` IN THE CONSTRUCTOR, and the venue
 * overrides `queuePath` only afterwards, so an unmodified run buffers into the
 * repo's own `data/publisher-queue.buffer.jsonl`, shared by all four hubs and
 * carrying every previous drill's rounds. That file is the input to
 * `_hydrateBuffer()` and therefore to the restart catch-up this drill's second
 * half depends on: a stale window in it would be re-proposed on restart and
 * counted into "exactly one wire". So `PUBLISHER_QUEUE_PATH` is pinned to a temp
 * directory BEFORE the venue comes up (which makes every hub start with an empty
 * buffer and no catch-up timer), and each publisher then gets its own buffer file
 * so no hub's prune rewrites another's durable copy.
 ********************************************************************/

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { OracleBatchVenue, ValidatorIdentity } = require('../helpers/oracleBatchVenue');
const drive        = require('../helpers/oracleBatchDrive');
const { waitFor }  = require('../helpers/consensusWait');

// AT6's own numbers. Six rounds is the window the spec ships and the one AT1
// names; four validators is the venue default and gives a weighted quorum of
// three, so a leader holding only its own signature is short by two and cannot
// reach quorum by any ordering of arrivals.
const WINDOW_ROUNDS  = 6;
const VALIDATORS     = 4;
const MIN_SIGNATURES = 3;

// Seconds, not the shipped five minutes: six rounds driven back to back
// in-process have no stragglers for the grace to wait for. This value is also the
// restart catch-up's delay, so it is paid twice in this drill.
const GRACE_MS = 4000;

// Seconds, not the shipped sixty. The first signing round is DESIGNED to expire
// here, so the drill would otherwise spend a shipped minute waiting out a result
// it already knows. It changes nothing about the outcome: no peer is listening
// for any of it.
const SIGN_TIMEOUT_MS = 10_000;

// How long the publication list must stay STILL before "nothing published" or
// "exactly one wire" is read as a property rather than a race won.
const QUIET_MS = 20_000;

// The one verdict a well-formed PRICE can legitimately record on a non-BTC
// indexer while a venue is still running a pre-fix indexer build.
const KNOWN_CAPABILITY_GAP_STATUS = 'invalid: insufficient signer stake';

// ---------------------------------------------------------------------------
// Local readers, and why they are local
// ---------------------------------------------------------------------------

/**
 * Split a PRICE batch wire into its parts.
 *
 * A LOCAL COPY ON PURPOSE, and the reason is a real defect, not a preference:
 * `oracleBatchDrive.parsePriceBatchWire` still gates on `version !== 2` and
 * returns `not-version-2` for every wire the publisher emits, because the batch
 * is now PRICE v0 (`OraclePublisher._emitWire` builds `'PRICE|0|' + body`). The
 * helper is out of this drill's jail, so the version gate is corrected here and
 * named in the report; everything else, including the inflate, is the helper's
 * own logic and goes through the SAME consensus module the landing chain runs, so
 * a wire this function accepts is a wire the chain accepts.
 */
function parseBatchWire(wire) {
    const priceBatch = drive.priceBatch;
    const parts = String(wire || '').split('|');
    if (parts[0] !== 'PRICE') return { ok: false, reason: 'not-a-price-wire' };
    const version = parseInt(parts[1], 10);
    if (version !== 0) return { ok: false, reason: 'not-the-batch-version', version: version };

    let body, compressed = false, compressedBytes = null, ratio = null;
    if (parts[2] === priceBatch.PRICE_BATCH_COMPRESSION_MARKER) {
        // Rejoining is required, not cosmetic: base64 has no `|`, but a hostile
        // wire may, and rejoining is what makes this reader see the same field the
        // indexer sees.
        const inflated = priceBatch.inflatePriceBatchBody(parts.slice(3).join('|'));
        if (!inflated.ok) return { ok: false, reason: inflated.reason, status: inflated.status, compressed: true };
        body            = inflated.body;
        compressed      = true;
        compressedBytes = inflated.compressedBytes;
        ratio           = inflated.ratio;
    } else {
        body = parts.slice(2).join('|');
    }

    const f = body.split('|');
    let i = 0;
    const firstRound = parseInt(f[i++], 10);
    const lastRound  = parseInt(f[i++], 10);
    const anchor     = parseInt(f[i++], 10);
    const roundCount = parseInt(f[i++], 10);
    const rounds = [];
    for (let r = 0; r < roundCount; r++) {
        const round     = parseInt(f[i++], 10);
        const timestamp = parseInt(f[i++], 10);
        const rAnchor   = parseInt(f[i++], 10);
        const pairCount = parseInt(f[i++], 10);
        const pairs = [];
        for (let p = 0; p < pairCount; p++) pairs.push({ pair: f[i++], price: f[i++] });
        rounds.push({ round: round, timestamp: timestamp, btcBlockHeight: rAnchor, pairs: pairs });
    }
    const sigCount = parseInt(f[i++], 10);
    const sigs = [];
    for (let s = 0; s < sigCount; s++) {
        sigs.push({ pubkey: String(f[i++]).toLowerCase(), sig: String(f[i++]).toLowerCase() });
    }

    return {
        ok: true, version: 0, compressed: compressed,
        body: body,
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        wireBytes: Buffer.byteLength(String(wire), 'utf8'),
        compressedBytes: compressedBytes, ratio: ratio,
        firstRound: firstRound, lastRound: lastRound, anchor: anchor,
        roundCount: roundCount, rounds: rounds, sigs: sigs
    };
}

/**
 * The hub index that will lead `windowIndex`, computed the way
 * `OraclePublisher._assembleWindow` computes it: the sorted lowercase
 * oracle_publish pubkey list at the window's anchor, indexed by
 * `windowIndex % length`.
 *
 * Read through the hub's own `capabilitySnapshot`, which is the source the
 * publisher reads, so this is a model of the election rather than a second
 * election. The drill does not TRUST it: it silences on this prediction and then
 * asserts the prediction against the leader the publishers themselves report.
 */
async function predictWindowLeader(venue, windowIndex, anchor) {
    const snap = await venue.mvh.hubs[0].capabilitySnapshot.getSnapshot('oracle_publish', anchor);
    const pubkeys = ((snap && Array.isArray(snap.validators)) ? snap.validators : [])
        .map((v) => String(v.pubkey).toLowerCase())
        .sort();
    if (pubkeys.length === 0) return { index: -1, rank: null, pubkey: null, publisherCount: 0 };
    const rank    = windowIndex % pubkeys.length;
    const pubkey  = pubkeys[rank];
    const index   = venue.mvh.hubs.findIndex(
        (h) => String(h.getIdentity().getPubkeyHex()).toLowerCase() === pubkey);
    return { index: index, rank: rank, pubkey: pubkey, publisherCount: pubkeys.length };
}

const sum    = (rows, key) => rows.reduce((acc, r) => acc + Number((r && r[key]) || 0), 0);
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

describe('AT6 oracle batch signing round: quorum withheld, then the SAME window republished (L3)', function () {
    // Six PBFT rounds, two signing rounds (one of which is spent expiring), a
    // publisher restart with its catch-up grace, an encoder build, a broadcast and a
    // confirmation on a real chain. The budget is per-suite; every wait inside is a
    // poll that returns the moment its condition holds.
    this.timeout(60 * 60 * 1000);

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

    before(async function () {
        // Pinned BEFORE the venue: OraclePublisher reads PUBLISHER_QUEUE_PATH,
        // ORACLE_BATCH_WINDOW_ROUNDS and ORACLE_BATCH_GRACE_MS in its CONSTRUCTOR, so a
        // value set after venue.up() is read by nobody. See the header on why the
        // buffer path in particular has to move before the hubs start.
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
            this.skip(); return;
        }
        if (!up) {
            console.log('AT6 venue unavailable: ' + venue.unavailable);
            await venue.down(); venue = null; releaseProcessState();
            this.skip(); return;
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

        // ---- PHASE 2: quorum restored, the SAME window re-proposed ----

        // Put every silenced peer back on the mesh FIRST, so the re-proposal meets a
        // federation that can actually answer it.
        signerSet.unsilence(silencedIndexes);

        // One round into the NEXT window. This is the precondition the shipped
        // restart catch-up requires, not a nudge: `_scheduleBufferCatchup` re-queues
        // every buffered window EXCEPT the newest, on the reasoning that the newest may
        // still be open. With only window W buffered, W IS the newest and the catch-up
        // would correctly leave it alone. Round `windowFirst + WINDOW_ROUNDS` is the
        // FIRST slot of W+1, so it arms no timer of its own and W+1 never assembles;
        // all it does is make W provably closed.
        nextWindowRound = await drive.finalizeRoundNoWait(venue, WINDOW_ROUNDS);

        const target = leaderIndex >= 0 ? leaderIndex : predicted.index;
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
        console.log('  ------------------------------------------------------------\n');
    });

    after(async function () {
        if (signerSet) signerSet.stop();
        // The venue's own down() clears each publisher's broadcast hook but never calls
        // stop(), which predates the batch rail's timers; released here so no window or
        // catch-up timer outlives the suite.
        if (venue) for (const pub of venue.publishers) { try { pub.stop(); } catch (e) { /* teardown */ } }
        if (venue) await venue.down();
        releaseProcessState();
    });

    it('the six rounds of the window finalized on a real multi-signature quorum', function () {
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

    it('the drill silenced the hub set the publishers themselves elected against', function () {
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

    it('with quorum withheld, the window published NOTHING and no fee was spent', function () {
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

    it('the leader ran a signing round, it EXPIRED SHORT, and batchSignTimeouts moved', function () {
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

    it('with quorum restored, the SAME window published, and exactly one wire', function () {
        assert.ok(restarted,
            'the drill never reached the re-proposal: no leader hub was identified for window ' + windowIndex);
        assert.ok(settle.reached,
            'RECOVERY rung: the window stayed unpublished after quorum was restored and the leader was ' +
            'restarted. A window that fails closed and cannot be recovered loses an hour of price history ' +
            'to one missed signing round, which is the failure AT6 exists to catch.' +
            drive.railDiagnosis(venue, signerSet));
        assert.strictEqual(venue.publications.length, 1,
            'the recovered window emitted ' + venue.publications.length + ' transaction(s); it must emit ' +
            'exactly one, or the retry paid a second DOGE fee for content already on chain.' +
            drive.railDiagnosis(venue, signerSet));
        assert.ok(settle.settled,
            'a second wire was still arriving when the quiet window expired, so "exactly one" is a race ' +
            'this run happened to win rather than a property.');

        const p = venue.publications[0];
        assert.strictEqual(p.wireVersion, 0,
            'the recovered window published PRICE v' + p.wireVersion + ', not the batch version 0');
        assert.ok(/^[0-9a-f]{64}$/.test(String(p.txid)),
            'PUSH rung: the publish returned ' + p.txid + ' rather than a transaction id');

        assert.ok(parsed.ok, 'the landed wire does not parse as a PRICE batch: ' + parsed.reason);
        assert.strictEqual(parsed.firstRound, windowFirst,
            'the recovered wire covers [' + parsed.firstRound + '..' + parsed.lastRound + '], not the ' +
            'withheld window [' + windowFirst + '..' + windowLast + ']. AT6 is the claim that the SAME ' +
            'window publishes, not that some later window does.');
        assert.strictEqual(parsed.lastRound, windowLast);
        assert.strictEqual(parsed.roundCount, WINDOW_ROUNDS);
        assert.deepStrictEqual(parsed.rounds.map((r) => r.round), rounds.map((r) => r.round),
            'the recovered wire carries rounds [' + parsed.rounds.map((r) => r.round).join(', ') +
            '] but the withheld window was [' + rounds.map((r) => r.round).join(', ') + ']');
        assert.ok(!parsed.rounds.some((r) => r.round === nextWindowRound.round),
            'the recovered wire swept in round ' + nextWindowRound.round + ', which belongs to window ' +
            (windowIndex + 1) + ' and would put a round outside the window on the window\'s own wire');
        const distinct = new Set(parsed.sigs.map((s) => s.pubkey));
        assert.ok(distinct.size >= MIN_SIGNATURES,
            'the recovered batch carries only ' + distinct.size + ' signature(s); a weighted quorum over ' +
            VALIDATORS + ' equal sources needs ' + MIN_SIGNATURES + '.' + drive.railDiagnosis(venue, signerSet));
    });

    it('the re-proposal\'s canonical is BYTE-IDENTICAL to the withheld attempt\'s (D17)', function () {
        assert.strictEqual(attempts.length, 2,
            'AT6 compares TWO proposals over window [' + windowFirst + '..' + windowLast + ']; the signers ' +
            'recorded ' + attempts.length + '. Fewer means the window was proposed only once (so there is ' +
            'no byte-identity to check); more means it was re-proposed repeatedly and the comparison ' +
            'below would be picking two runs arbitrarily.' + drive.railDiagnosis(venue, signerSet));

        const withheld = attempts[0];
        const recovery = attempts[1];
        assert.strictEqual(withheld.met, false, 'the FIRST proposal reached quorum; AT6 needs it to fail');
        assert.strictEqual(recovery.met, true, 'the SECOND proposal did not reach quorum');
        assert.strictEqual(withheld.hubIndex, leaderIndex);
        assert.strictEqual(recovery.hubIndex, leaderIndex,
            'the re-proposal came from hub ' + recovery.hubIndex + ' rather than the window\'s elected ' +
            'leader (hub ' + leaderIndex + '), which would mean leader election is not a pure function of ' +
            'the window index after all');

        assert.ok(withheld.canonical && recovery.canonical,
            'a proposal recorded no canonical bytes, so there is nothing to compare');
        assert.strictEqual(withheld.anchor, recovery.anchor,
            'the two proposals resolved different batch anchors (' + withheld.anchor + ' vs ' +
            recovery.anchor + '), so they would be judged by different capability sets');
        assert.deepStrictEqual(withheld.rounds, recovery.rounds,
            'the two proposals covered different round sets');

        // Compared by digest and by length FIRST so a mismatch reports a readable
        // difference instead of dumping two multi-kilobyte canonicals, then by the raw
        // strings, which is the claim itself.
        const a = withheld.canonical, b = recovery.canonical;
        assert.strictEqual(sha256(a), sha256(b),
            'D17: a re-proposal of the SAME window must produce byte-identical canonical content. The ' +
            'withheld attempt signed ' + Buffer.byteLength(a, 'utf8') + ' bytes (sha256 ' + sha256(a) +
            ') and the recovery signed ' + Buffer.byteLength(b, 'utf8') + ' bytes (sha256 ' + sha256(b) +
            '). Non-determinism here means a validator that co-signed the first attempt could be shown ' +
            'signing two different batches over one window at one anchor, which is the equivocation shape ' +
            'the XORACLEB round id exists to keep honest.');
        assert.strictEqual(Buffer.byteLength(a, 'utf8'), Buffer.byteLength(b, 'utf8'));
        assert.ok(a === b, 'the two canonicals share a sha256 but differ as strings');

        // And the bytes that were compared are the bytes the CHAIN now carries a quorum
        // over: without this the byte-identity claim could be about two proposals that
        // neither of them published.
        let verified = 0;
        for (const s of parsed.sigs) if (ValidatorIdentity.verify(recovery.canonical, s.sig, s.pubkey)) verified++;
        assert.strictEqual(verified, parsed.sigs.length,
            'only ' + verified + ' of ' + parsed.sigs.length + ' signatures on the landed wire verify ' +
            'against the canonical the recovery round produced, so the compared bytes are not the ' +
            'published bytes');
    });

    it('the recovered wire was mined and the landing chain stored the window it carried', function () {
        assert.ok(venue.publications.length > 0,
            'RECOVERY rung: nothing was broadcast for window ' + windowIndex + ', so there is no ' +
            'transaction to look for on chain.' + drive.railDiagnosis(venue, signerSet));
        assert.ok(block && Number.isFinite(Number(block.height)),
            'PUSH rung: transaction ' + venue.publications[0].txid + ' is not in a block on the ' +
            venue.rail.code + ' node');
        assert.ok(indexed, 'the landing chain\'s indexer recorded no prices row: ' + indexError);
        assert.strictEqual(Number(indexed.version), 0,
            'PARSE rung: the indexer recorded PRICE version ' + indexed.version + ' for a batch wire');
        assert.strictEqual(Number(indexed.batch_first_round), windowFirst,
            'PARSE rung: the indexer stored batch_first_round ' + indexed.batch_first_round +
            ' for the window [' + windowFirst + '..' + windowLast + ']');
        assert.strictEqual(Number(indexed.batch_last_round), windowLast);
        assert.strictEqual(Number(indexed.round_count), WINDOW_ROUNDS);
        const storedRounds = JSON.parse(indexed.rounds_json || '[]');
        assert.strictEqual(storedRounds.length, WINDOW_ROUNDS,
            'PARSE rung: rounds_json holds ' + storedRounds.length + ' round(s), not ' + WINDOW_ROUNDS);
    });

    it('the landing chain accepted the recovered batch [WAITING on a venue indexer at develop]', function () {
        assert.ok(indexed, 'no prices row to read a verdict from: ' + indexError);
        const status = String(indexed.status);
        if (status === KNOWN_CAPABILITY_GAP_STATUS) {
            console.log('  AT6\'s verdict assertion is WAITING, not failing. The recovered batch parsed, ' +
                'stored all ' + WINDOW_ROUNDS + ' rounds and carried ' + parsed.sigs.length + ' verifying ' +
                'signatures, and the ' + venue.rail.code + ' indexer still recorded "' + status + '". The ' +
                'off-BTC `price` capability fix has landed on develop, so this now means the VENUE ' +
                'indexer is behind the checkout rather than that the gap is open. AT6\'s own claim is ' +
                'about the signing round and is unaffected either way.');
            this.skip();
            return;
        }
        assert.strictEqual(status, 'valid',
            'SIGNER RESOLUTION rung: the recovered batch indexed as "' + status + '". Expected either ' +
            '"valid" or the known "' + KNOWN_CAPABILITY_GAP_STATUS + '". Anything else is a parse, fee or ' +
            'wire regression, not a stale venue.' + drive.railDiagnosis(venue, signerSet));
    });
});
