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
 * leader's publisher is restarted. `start()`'s `scheduleBufferCatchup()` then
 * re-queues exactly the windows a restart dropped, W among them. That path is
 * entirely shipped code: this file triggers it, it does not reimplement it and it
 * pokes no private memo to unstick the window. See the report for the gap.
 *
 * THE BYTE-IDENTITY ASSERTION IS TAKEN FROM THE SIGNER, NOT REBUILT HERE. D17
 * rules that split boundaries need NOT agree across leaders, so "the same batch"
 * is not a claim this drill may make about ranges in general; what D17 does bind,
 * and what AT6 names, is that a re-proposal of the SAME window produces
 * byte-identical canonical content. `oracleBatchDrive.attachBatchSigners` wraps
 * `canonical` on each signer, so both attempts hand back the bytes the REAL
 * builder produced, and the comparison is between two runs of the producer rather
 * than between the producer and a test-side re-derivation of it.
 *
 * THE BUFFER PATH IS REDIRECTED HERE, and it is load-bearing. OraclePublisher
 * derives `bufferPath` from `queuePath` IN THE CONSTRUCTOR, and the venue
 * overrides `queuePath` only afterwards, so an unmodified run buffers into the
 * repo's own `data/publisher-queue.buffer.jsonl`, shared by all four hubs and
 * carrying every previous drill's rounds. That file is the input to
 * `hydrateBuffer()` and therefore to the restart catch-up this drill's second
 * half depends on: a stale window in it would be re-proposed on restart and
 * counted into "exactly one wire". So `PUBLISHER_QUEUE_PATH` is pinned to a temp
 * directory BEFORE the venue comes up (which makes every hub start with an empty
 * buffer and no catch-up timer), and each publisher then gets its own buffer file
 * so no hub's prune rewrites another's durable copy.
 ********************************************************************/

const crypto = require('crypto');
const { ValidatorIdentity } = require('../../../helpers/oracleBatchVenue');
const drive = require('../../../helpers/oracleBatchDrive');

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
 * is now PRICE v0 (`OraclePublisher.emitWire` builds `'PRICE|0|' + body`). The
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
 * `OraclePublisher.assembleWindow` computes it: the sorted lowercase
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

module.exports = {
    drive,
    ValidatorIdentity,
    WINDOW_ROUNDS,
    VALIDATORS,
    MIN_SIGNATURES,
    GRACE_MS,
    SIGN_TIMEOUT_MS,
    QUIET_MS,
    KNOWN_CAPABILITY_GAP_STATUS,
    parseBatchWire,
    predictWindowLeader,
    sum,
    sha256,
};
