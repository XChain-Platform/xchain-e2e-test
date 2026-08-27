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
 * WINDOW DRIVER for the PRICE v0 acceptance drills (spec section 11).
 *
 * `oracleBatchVenue.js` drives ROUNDS: finalizeRound() carries exactly one
 * finalized round all the way to a landed transaction before it returns. That is
 * the right shape for the v0 rail, where one round is one wire, and the wrong
 * shape for every v2 drill, where K rounds are ONE wire: the venue would wait
 * PUBLISH_WAIT_MS for a broadcast that is not supposed to happen yet and throw
 * on round 1 of 6.
 *
 * So this file adds the two things a batch drill needs and nothing else. Both
 * were MEASURED on a live venue run, not reasoned about:
 *
 *   1. A round driver that stops at "finalized on every hub" instead of at
 *      "landed on chain" (`finalizeRoundNoWait`), plus a window-close wait that
 *      watches the publication list settle (`waitForPublications`). A drill that
 *      needs a six-round window drives six rounds and then waits ONCE.
 *
 *   2. A batch signer on EVERY hub (`attachBatchSigners`). OraclePublisher
 *      creates an OracleBatchSigner lazily, and only the elected LEADER ever
 *      reaches that code, so on an otherwise-correct federation no follower has
 *      registered the XPRICEB message handler and the leader's signing round
 *      expires with `timed out at 1/3 sigs`. The signing round is a peer
 *      protocol; every peer has to be listening before the round opens.
 *
 * WHAT IS REAL HERE. Everything. This file starts real OracleBatchSigner
 * instances on the venue's real hubs, injects the same per-validator submissions
 * the venue injects, and calls the same real OracleConsensus.finalizeRound. The
 * only thing it withholds is a WAIT. Nothing is stubbed, and in particular
 * nothing here supplies, forges or short-circuits a signature: quorum is reached
 * by the hubs talking to each other over their real mesh, or it is not reached.
 *
 * WHY THE INSTRUMENTATION IS A WRAPPER AND NOT A FORK. `collectBatchSignatures`
 * and `_canonical` are wrapped on the signer instances THIS file constructs, so
 * a drill can read the exact proposal the leader made and the exact canonical
 * bytes it signed over. Wrapping is what keeps AT6's "byte-identical canonical
 * content" claim honest: the bytes compared are the bytes the real builder
 * produced on each attempt, not a re-derivation a test wrote for itself.
 *
 * RUNG NAMING. `railDiagnosis()` renders the whole rail in one block: what each
 * hub buffered, what its publisher counted, what its signer counted, and what
 * reached the chain. Every assertion in the drills carries it, so a red test says
 * WHICH rung broke (no proposal at all -> leader/rank; timeouts -> signing round;
 * unpublishable -> the wire ceiling; publications but no row -> broadcast or
 * decoder; a row with an invalid status -> parse or signer resolution) instead of
 * reporting a mismatch and leaving the reader to guess.
 ********************************************************************/

const path = require('path');

const { submissionsForRound } = require('./oracleBatchVenue');
const { loadHubModule }       = require('./multiValidatorHubHelper');
const { waitFor }             = require('./consensusWait');

const OracleBatchSigner = loadHubModule('src/OracleBatchSigner.js');

// The consensus compression module, read from the INDEXER copy. The hub vendors a
// byte-identical twin and the parity tests in both repos fail on a one-sided edit,
// so either copy is the same module; the indexer's is the one a landing chain
// actually runs, which is the side every drill here is making a claim about.
const priceBatch = require(path.resolve(__dirname, '../../../xchain-indexer/src/price_batch_compression.js'));

// How long a finalized round has to appear in every hub's own price_snapshots.
// This is pure in-process consensus plus one INSERT per hub; it is nowhere near
// the venue's chain-bound budget and a longer wait would only slow a red run.
const FINALIZE_WAIT_MS = 120_000;

// ---------------------------------------------------------------------------
// Environment pinning
// ---------------------------------------------------------------------------

/**
 * Pin the batch window and its grace for one drill.
 *
 * MUST be called BEFORE venue.up(): OraclePublisher reads both values in its
 * constructor (`positiveIntConfig(process.env.ORACLE_BATCH_WINDOW_ROUNDS || ...)`),
 * so a value set afterwards is read by nobody.
 *
 * The shipped window is six rounds and the shipped grace is five minutes, which
 * is correct for an hourly production cadence and useless in a drill: a
 * one-round drill would publish nothing for five of its six rounds, and a
 * six-round drill would idle for five minutes at the close. Every drill states
 * the window it needs, and states it here rather than in a config file so the
 * value and the assertion that depends on it sit in the same run.
 */
function pinBatchWindow(opts) {
    opts = opts || {};
    const saved = {
        ORACLE_BATCH_WINDOW_ROUNDS: process.env.ORACLE_BATCH_WINDOW_ROUNDS,
        ORACLE_BATCH_GRACE_MS:      process.env.ORACLE_BATCH_GRACE_MS
    };
    if (opts.windowRounds !== undefined) process.env.ORACLE_BATCH_WINDOW_ROUNDS = String(opts.windowRounds);
    if (opts.graceMs      !== undefined) process.env.ORACLE_BATCH_GRACE_MS      = String(opts.graceMs);
    return {
        restore() {
            for (const k of Object.keys(saved)) {
                if (saved[k] === undefined) delete process.env[k];
                else process.env[k] = saved[k];
            }
        }
    };
}

/**
 * A round base aligned to the start of a window, so `count` consecutive rounds
 * fall inside ONE window and the window closes on the last of them.
 *
 * OraclePublisher indexes windows as `floor(round / windowRounds)` and arms the
 * close timer when `round % windowRounds === windowRounds - 1`. An unaligned base
 * therefore splits six rounds across two windows and produces two wires, which
 * would fail AT1 for a reason that has nothing to do with the code under test.
 * Seconds-since-epoch rounded DOWN to the window keeps the venue's own
 * no-collision-across-reruns property (see OracleBatchVenue.roundBase).
 */
function alignedRoundBase(windowRounds) {
    const w = Math.max(1, parseInt(windowRounds, 10) || 1);
    return Math.floor(Math.floor(Date.now() / 1000) / w) * w;
}

// ---------------------------------------------------------------------------
// The signing round
// ---------------------------------------------------------------------------

/**
 * Start a real OracleBatchSigner on EVERY hub in the venue.
 *
 * Not an optimization and not instrumentation: without it the batch rail cannot
 * reach quorum at all. `OraclePublisher._getBatchSigner()` constructs a signer
 * lazily and is only ever reached by the hub that wins the window's leader
 * election, so the other N-1 hubs never call `peerManager.on('message', ...)` for
 * XPRICEB and never answer a sign request. The leader then collects exactly its
 * own signature and the round expires short.
 *
 * `hub.oracleBatchSigner` is the field the publisher PREFERS, so setting it also
 * guarantees the leader uses this instance rather than making a second one.
 *
 * @param opts.signTimeoutMs  override the signer's 60s round timeout. A drill
 *                            that deliberately withholds quorum sets this small
 *                            so it measures a timeout instead of waiting one out.
 */
function attachBatchSigners(venue, opts) {
    opts = opts || {};
    const signers   = [];
    const proposals = [];   // every collectBatchSignatures call, in order

    for (let i = 0; i < venue.mvh.hubs.length; i++) {
        const hub    = venue.mvh.hubs[i];
        const signer = new OracleBatchSigner(hub);
        if (opts.signTimeoutMs !== undefined) signer.signTimeoutMs = opts.signTimeoutMs;

        // Record the canonical the leader actually signed over. Wrapped rather than
        // re-derived in the drill, because AT6's claim is about the bytes the REAL
        // builder produced on two separate attempts; a test-side re-derivation would
        // be comparing the test to itself.
        const origCanonical = signer._canonical.bind(signer);
        signer._canonical = function (first, last, anchor, rounds) {
            const bytes = origCanonical(first, last, anchor, rounds);
            signer._lastCanonical = bytes;
            return bytes;
        };

        const origCollect = signer.collectBatchSignatures.bind(signer);
        signer.collectBatchSignatures = async function (first, last, anchor, rounds) {
            const entry = {
                hubIndex: i,
                first:    parseInt(first, 10),
                last:     parseInt(last, 10),
                anchor:   parseInt(anchor, 10),
                rounds:   rounds.map((r) => parseInt(r.round, 10)),
                startedAt: Date.now()
            };
            proposals.push(entry);
            const result = await origCollect(first, last, anchor, rounds);
            entry.met       = !!(result && result.met);
            entry.sigCount  = (result && Array.isArray(result.sigs)) ? result.sigs.length : 0;
            // On a timeout the signer returns no canonical (there is nothing to
            // publish), so fall back to the bytes the wrapper above captured, which are
            // the same bytes either way.
            entry.canonical = (result && result.canonical) || signer._lastCanonical || null;
            entry.endedAt   = Date.now();
            return result;
        };

        hub.oracleBatchSigner = signer;
        signer.start();
        signers.push(signer);
    }

    return {
        signers:   signers,
        proposals: proposals,
        stats()    { return signers.map((s) => s.getStats()); },
        /** Silence a subset of hubs' signers, so a leader cannot reach quorum. */
        silence(indexes) { for (const i of indexes) signers[i].stop(); },
        /** Put silenced signers back on the mesh. */
        unsilence(indexes) { for (const i of indexes) signers[i].start(); },
        stop() {
            for (let i = 0; i < signers.length; i++) {
                try { signers[i].stop(); } catch (_) { /* teardown is best effort */ }
                try { delete venue.mvh.hubs[i].oracleBatchSigner; } catch (_) { /* ditto */ }
            }
        }
    };
}

// ---------------------------------------------------------------------------
// Driving rounds without waiting for a publish
// ---------------------------------------------------------------------------

/**
 * Drive ONE real PBFT price round across every hub and return when every hub
 * holds its own finalized `price_snapshots` rows. Deliberately does NOT wait for
 * a broadcast: under the v2 rail a finalized round produces no transaction of its
 * own, and the wait the venue's own finalizeRound performs would time out.
 *
 * Waiting for the row on EVERY hub is not politeness, it is a precondition of the
 * signing round: a follower co-signs only what it can rebuild from its own
 * `price_snapshots` (`OracleBatchSigner._deriveWindow`), and the leader withholds
 * a window whose rounds it cannot self-check (`_windowCoverageComplete`). Opening
 * the window before the rows exist is how a drill produces a silent refusal that
 * looks like a signing bug.
 */
async function finalizeRoundNoWait(venue, index, opts) {
    opts = opts || {};
    const round      = venue.roundBase + index;
    const anchorTime = venue.anchorTimeBase + index * 600;
    const prices     = opts.prices || submissionsForRound(venue.pairs, index);

    const addrs = venue.mvh.hubs.map((h) => h.getPeerManager().validatorAddr);
    for (let i = 0; i < venue.mvh.hubs.length; i++) {
        const subs = new Map();
        for (const addr of addrs) subs.set(addr, { prices: prices });
        venue._oracles[i].round.submissions.set(round, subs);
    }

    await Promise.all(venue.mvh.hubs.map((h, i) =>
        venue._oracles[i].oc.finalizeRound(round, venue.anchorHeight, anchorTime)
            .catch((e) => { console.warn('oracleBatchDrive: hub ' + i + ' finalizeRound threw: ' + (e && e.message)); })));

    const finalized = await waitFor(async () => {
        const counts = [];
        for (const hub of venue.mvh.hubs) {
            try { counts.push((await venue._snapshotRows(hub, round)).length); }
            catch (_) { counts.push(0); }
        }
        return { ok: counts.length > 0 && counts.every((c) => c >= 1), counts: counts };
    }, { timeoutMs: opts.timeoutMs || FINALIZE_WAIT_MS });

    if (!finalized.ok) {
        throw new Error('oracleBatchDrive: round ' + round + ' never finalized on every hub within ' +
            finalized.waitedMs + 'ms; per-hub finalized price_snapshots row counts were [' +
            ((finalized.last && finalized.last.counts) || []).join(', ') + ']. This is the CONSENSUS ' +
            'rung, upstream of anything the batch rail does.');
    }

    const events = venue._finalizedEvents.get(round) || [];
    const lead   = events.find((e) => e && Array.isArray(e.signatures)) || null;
    return {
        round:      round,
        anchorTime: anchorTime,
        prices:     prices,
        signatures: lead ? lead.signatures : []
    };
}

/** Drive `count` rounds back to back, none of them waiting for a broadcast. */
async function finalizeRoundsNoWait(venue, count, opts) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(await finalizeRoundNoWait(venue, i, opts));
    return out;
}

/**
 * Wait for the window to close and settle.
 *
 * Two-phase on purpose. Phase one waits for `min` publications, which is the
 * event a drill is usually asserting on. Phase two then waits for the list to
 * stay STILL for `quietMs`, which is the half that makes "exactly one wire" a
 * real claim rather than a race won: a second wire arriving a second after the
 * first would otherwise pass an assertion taken the instant the first landed.
 *
 * Returns { reached, settled, count }. Never throws on a shortfall: a drill that
 * EXPECTS nothing to publish (AT6's withheld quorum) calls this with min 0 and
 * asserts the count, and turning a shortfall into an exception here would make
 * that drill unwritable.
 */
async function waitForPublications(venue, opts) {
    opts = opts || {};
    const min      = opts.min === undefined ? 1 : opts.min;
    const quietMs  = opts.quietMs === undefined ? 20_000 : opts.quietMs;
    const timeout  = opts.timeoutMs === undefined ? 300_000 : opts.timeoutMs;

    const reached = await waitFor(
        async () => ({ ok: venue.publications.length >= min, count: venue.publications.length }),
        { timeoutMs: timeout, intervalMs: 500 });

    let last = venue.publications.length;
    let quietSince = Date.now();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && Date.now() - quietSince < quietMs) {
        await new Promise((r) => setTimeout(r, 500));
        if (venue.publications.length !== last) { last = venue.publications.length; quietSince = Date.now(); }
    }
    return { reached: reached.ok, settled: Date.now() - quietSince >= quietMs, count: venue.publications.length };
}

// ---------------------------------------------------------------------------
// Reading a PRICE v0 wire
// ---------------------------------------------------------------------------

/**
 * Split a PRICE v0 wire into its parts, handling BOTH forms exactly as the
 * indexer's `_parseV0` distinguishes them: `Z` in the FIRST_ROUND slot means the
 * remainder is base64 deflate-raw, anything else means the body is already there.
 *
 * The inflate goes through the CONSENSUS module, not through zlib directly, so a
 * wire this function accepts is a wire the chain accepts and a drill cannot read
 * a body an indexer would refuse.
 *
 * Returns { ok:false, reason, status } on a wire the consensus module rejects, so
 * a hostile-wire drill can assert on the same failure the chain records.
 */
function parsePriceBatchWire(wire) {
    const parts = String(wire || '').split('|');
    if (parts[0] !== 'PRICE') return { ok: false, reason: 'not-a-price-wire' };
    const version = parseInt(parts[1], 10);
    if (version !== 2) return { ok: false, reason: 'not-version-2', version: version };

    let body, compressed = false, compressedBytes = null, ratio = null;
    if (parts[2] === priceBatch.PRICE_BATCH_COMPRESSION_MARKER) {
        // Field 3 onward is the base64 payload. Rejoining is required, not
        // cosmetic: base64 has no `|`, but a hostile wire may, and rejoining is
        // what makes this reader see the same field the indexer sees.
        const field    = parts.slice(3).join('|');
        const inflated = priceBatch.inflatePriceBatchBody(field);
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
    for (let s = 0; s < sigCount; s++) sigs.push({ pubkey: String(f[i++]).toLowerCase(), sig: String(f[i++]).toLowerCase() });

    return {
        ok: true, version: 2, compressed: compressed,
        body: body,
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        wireBytes: Buffer.byteLength(String(wire), 'utf8'),
        compressedBytes: compressedBytes,
        ratio: ratio,
        firstRound: firstRound, lastRound: lastRound, anchor: anchor,
        roundCount: roundCount, rounds: rounds, sigs: sigs
    };
}

// ---------------------------------------------------------------------------
// Landing a wire this rail did not produce
// ---------------------------------------------------------------------------

/**
 * Broadcast an arbitrary wire from the venue's funded publisher address.
 *
 * The hostile-wire and tamper drills need bytes on the chain that no honest
 * publisher would ever emit, so they cannot come out of OraclePublisher. They go
 * on the SAME rail everything else does (same encoder, same signature, same node
 * broadcast) and are read back by the same indexer, which is what makes "the
 * chain rejects this" a statement about the chain.
 *
 * Deliberately does NOT push onto venue.publications: that list is the
 * PUBLISHER's record, and a drill counting "exactly one wire the federation
 * produced" must not have a test-authored transaction counted into it.
 */
async function broadcastWire(venue, wire) {
    const transactionHelper = require('../transactionHelper');
    const capture = {};
    const txid = await transactionHelper.createAndSendTransaction(
        venue.publisherAddress, wire, null, [], null, null, false, { capture });
    return {
        wire:      wire,
        wireBytes: Buffer.byteLength(wire, 'utf8'),
        txid:      txid,
        encoding:  capture.encoding || null
    };
}

// ---------------------------------------------------------------------------
// Failure diagnosis
// ---------------------------------------------------------------------------

/**
 * The whole rail in one block, for an assertion message.
 *
 * Each line isolates one rung, so a red drill names the rung instead of the
 * symptom:
 *   buffered=0            -> the round never reached the publisher (CONSENSUS)
 *   leader/follower 0/0   -> no window ever assembled (SCHEDULER or activation)
 *   signRounds 0          -> the leader never proposed (LEADER ELECTION or coverage)
 *   signTimeouts > 0      -> proposed and did not reach quorum (SIGNING ROUND)
 *   refusals > 0          -> peers could not reproduce the bytes (CANONICAL)
 *   unpublishable > 0     -> quorum reached, wire too big (WIRE CEILING)
 *   publications 0        -> assembled and enqueued but never broadcast (PUSH)
 *   publications > 0      -> everything above is fine; look at the indexed status
 */
function railDiagnosis(venue, signerSet) {
    const lines = [];
    const pubStats = venue.publisherStats();
    for (let i = 0; i < pubStats.length; i++) {
        const s = pubStats[i];
        const sg = signerSet ? signerSet.signers[i].getStats() : {};
        lines.push('    hub ' + i +
            '  buffered=' + (s.batchBufferDepth === undefined ? '?' : s.batchBufferDepth) +
            '  leader/follower=' + s.leaderRounds + '/' + s.followerRounds +
            '  splits=' + s.batchSplitCount +
            '  unpublishable=' + s.batchUnpublishableCount +
            '  queued=' + (s.queueDepth === undefined ? '?' : s.queueDepth) +
            '  | signRounds=' + (sg.batchSignRounds || 0) +
            '  quorums=' + (sg.batchSignQuorums || 0) +
            '  timeouts=' + (sg.batchSignTimeouts || 0) +
            '  gave=' + (sg.batchSignaturesProvided || 0) +
            '  refused=' + (sg.batchSignRefusals || 0));
    }
    lines.push('    publications=' + venue.publications.length + (venue.publications.length === 0 ? '' :
        ': ' + venue.publications.map((p) => 'v' + p.wireVersion + '/' + p.wireBytes + 'B/' +
            String(p.txid).slice(0, 12)).join(', ')));
    return '\n  --- rail state ---\n' + lines.join('\n') + '\n  ------------------';
}

module.exports = {
    pinBatchWindow,
    alignedRoundBase,
    attachBatchSigners,
    finalizeRoundNoWait,
    finalizeRoundsNoWait,
    waitForPublications,
    parsePriceBatchWire,
    broadcastWire,
    railDiagnosis,
    priceBatch
};
