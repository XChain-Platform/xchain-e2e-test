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
 * AT3 (splitting and the ceiling), verbatim: "an overflowing window publishes as
 * split batches that all land; a single round that cannot fit increments
 * `batchUnpublishableCount`, dead-letters and logs CRITICAL".
 *
 * Two windows, one venue, one federation, both driven on the real DOGE regtest
 * publish rail.
 *
 *   WINDOW A, the split. Four finalized rounds, each carrying enough pair data
 *   that TWO of them fill a wire and THREE do not. The real packer therefore
 *   emits two wires of two rounds each. That shape is the claim: a split is the
 *   packer choosing the largest RANGE that fits, not the packer degenerating to
 *   one round per transaction. Both wires must reach a block and be stored by the
 *   landing chain's own indexer.
 *
 *   WINDOW B, the ceiling. Four finalized rounds, of which the THIRD alone
 *   carries more pair data than any wire form can hold. The window still packs
 *   and publishes its neighbours (rounds 1-2 as one wire, round 4 as another),
 *   while the oversized round increments `batchUnpublishableCount`, writes a
 *   dead-letter record and logs a CRITICAL line. Putting the ceiling INSIDE a
 *   window that otherwise publishes is deliberate: it proves the unpublishable
 *   round is isolated rather than poisoning the hour around it.
 *
 * HOW THE OVERFLOW IS FORCED, and why it is not a mock. `PRICE_WIRE_MAX_BYTES`
 * is a module-level const in `xchain-hub/src/OraclePublisher.js:92`; neither the
 * constructor nor any of the four `ORACLE_BATCH_*` knobs exposes it, and the two
 * env knobs that DO exist (`ORACLE_BATCH_WINDOW_ROUNDS`, `ORACLE_BATCH_GRACE_MS`)
 * change cadence, not capacity. So there is no limit to inject, and lowering one
 * by monkey-patching `_wireFits` would replace the predicate under test with a
 * test-authored one. Instead the rounds are made genuinely large: real pairs,
 * really aggregated by a real trimmed median on four real validators, really
 * signed by a real quorum, really packed by `_packSegment` against the real
 * `_emitWire`/`_wireFits` pair, and really refused at the real 8,189-byte bound.
 *
 * The pair counts are not guessed. Before a single round is driven, this drill
 * CALIBRATES them by binary search against the publisher's OWN `_emitWire`,
 * `_placeholderSigs` and `_wireFits` on the venue's own publisher instance, so
 * the sizes it picks are the sizes that class will measure later. The calibration
 * is then re-asserted as evidence in its own `it()`: if a future encoder or
 * compression change moves the bound, this drill says the premise moved rather
 * than reporting a rail failure.
 *
 * WHICH BOUND ACTUALLY BINDS, and it is the interesting half of section 8. These
 * bodies compress extremely well, so the emitted wire is far under the encoder's
 * payload limit while the INFLATED body is far over the reader's cap. `_wireFits`
 * checks both, which is exactly why the overflow is reproducible at all:
 * compression buys fee, not round capacity.
 *
 * THE PAIR SET IS REAL FIRST, SYNTHETIC ONLY WHERE IT HAS TO BE. Every round
 * carries the federation's entire canonical pair list (35 of the 36 pairs
 * `PriceFetcher.getCoinPairs()` names; XCHAIN/USD and DOGE/USD are held out
 * because `nativeFeeHelper.seedGlobalPrices` clears and re-seeds exactly those
 * two on every action tx), and only the OVERFLOW above that is synthesized. The
 * synthetic tickers are six uppercase letters, which is what the widened regtest
 * pair bound accepts, and they are added to each hub's co-sign whitelist before
 * any round runs: `OracleConsensus._handlePropose` refuses to co-sign a pair
 * outside `oracleRound.canonicalPairs`, so without that a follower withholds the
 * whole round and no batch exists to split. That widening changes WHICH pairs the
 * federation is willing to price, which is feed configuration; it touches nothing
 * in the packing, signing or publishing path this drill makes a claim about.
 *
 * THREE HELPER GAPS ARE WORKED AROUND HERE, NOT EDITED (see the report):
 *   1. `oracleBatchDrive.parsePriceBatchWire` still refuses any wire whose
 *      version field is not `2`, while the publisher now emits `PRICE|0|` after
 *      the v0 collapse. A local `readBatchWire` mirrors it field for field and
 *      routes the compressed form through the SAME consensus module
 *      (`drive.priceBatch`), so a wire this file reads is a wire the chain reads.
 *   2. `OracleBatchVenue._attachPublishers` redirects `queuePath`,
 *      `deadLetterPath` and the spend-guard state into a temp directory, but
 *      `bufferPath` is derived from `queuePath` in the OraclePublisher
 *      CONSTRUCTOR, so it is still `./data/publisher-queue.buffer.jsonl` for all
 *      four hubs at once, in the checkout. This drill re-points it per hub and
 *      drops whatever the shared file hydrated, before any round is driven.
 *   3. `OracleBatchVenue`'s `pairs` constructor option cannot express a pair
 *      outside `PriceFetcher.getCoinPairs()`: it reaches the submissions and not
 *      the co-sign whitelist, so any such pair silently fails to finalize. The
 *      whitelist widening above is that gap's workaround.
 *
 * NOTHING HERE IS STUBBED. No signature is forged, no wire is hand-built, no
 * counter is written by the test, and no publish path is short-circuited. The
 * only things this file supplies are the pair sets the federation prices and the
 * window size it prices them in.
 ********************************************************************/

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const util   = require('util');

const { OracleBatchVenue } = require('../helpers/oracleBatchVenue');
const drive = require('../helpers/oracleBatchDrive');

// Four rounds per window, so a split can be a RANGE split (2+2) rather than the
// degenerate one-round-per-wire case a two-round window would force.
const WINDOW_ROUNDS  = 4;
const VALIDATORS     = 4;
const MIN_SIGNATURES = 3;

// Seconds rather than the shipped five minutes: the grace exists so real
// stragglers on a real hour boundary can arrive, and rounds driven back to back
// in-process have no stragglers to wait for.
const GRACE_MS = 8000;

// `PRICE_WIRE_MAX_BYTES`, restated so the calibration evidence is readable
// without opening the hub. It decides nothing: every fit decision in this file
// is delegated to the publisher's own `_wireFits`.
const WIRE_MAX_BYTES = 8189;

// The one verdict a well-formed PRICE can legitimately record on a non-BTC
// indexer while the price-capability gap is open. AT3 is a claim about what the
// federation EMITS and what reaches a block, not about the verdict, so this is
// tolerated rather than asserted either way.
const KNOWN_CAPABILITY_GAP_STATUS = 'invalid: insufficient signer stake';

// ---------------------------------------------------------------------------
// Pair sets
// ---------------------------------------------------------------------------

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Held out of the pair set: `nativeFeeHelper.seedGlobalPrices` clears and
// re-seeds exactly these two on every action transaction, so a drill that priced
// them would have its own rounds rewritten underneath it by its own fee output.
const HELD_OUT_PAIRS = new Set(['XCHAIN/USD', 'DOGE/USD']);

// The widened regtest pair bound (`price_pair_activation.js`, threshold 0 on
// regtest). Restated only to filter the canonical list; the chain enforces its own.
const PAIR_RE = /^[A-Z]{3,6}\/[A-Z]{3,5}$/;

// How many distinct pair names the calibration may reach for. The binary searches
// below never look past this, so building the list once up front costs nothing.
const NAME_POOL = 1600;

// The run's pair names: every canonical pair the federation really prices, in
// sorted order, then synthetic six-letter tickers for the overflow above that.
// Filled in before(), because the canonical set is read off the venue's own
// OracleRound rather than restated here.
let NAMES = [];

// A six-letter ticker. Prefixed 'P' and checked against the canonical set, so a
// synthetic name can never shadow a real pair.
function tickerFor(i) {
    let s = '', n = i;
    for (let k = 0; k < 5; k++) { s = ALPHA[n % 26] + s; n = Math.floor(n / 26); }
    return 'P' + s;
}

function buildNames(venue) {
    const seen = new Set();
    const real = [];
    for (const p of venue._oracles[0].round.canonicalPairs) {
        if (HELD_OUT_PAIRS.has(p) || !PAIR_RE.test(p) || seen.has(p)) continue;
        seen.add(p); real.push(p);
    }
    real.sort();
    const out = real.slice(0);
    let i = 0;
    while (out.length < NAME_POOL) {
        const n = tickerFor(i++) + '/USD';
        if (seen.has(n)) continue;
        seen.add(n); out.push(n);
    }
    return { names: out, realCount: real.length };
}

// Three integer digits, always. The federation's trimmed median re-spells every
// price to eight decimals (`bcmath.bcformat(..., 8)`), so a three-digit
// submission lands on the wire as exactly twelve characters and the calibration
// below can predict the byte cost of a pair without predicting the aggregate.
// Constant across rounds for a given pair, which puts every propose-path
// deviation at exactly zero: this drill is a claim about SIZE, and a price walk
// would only add a way for it to fail for an unrelated reason.
function pairPriceFor(i) { return String(100 + (i % 400)); }

// What the hubs are handed.
function submissionSet(pairCount) {
    const out = [];
    for (let i = 0; i < pairCount; i++) out.push({ coinPair: NAMES[i], price: pairPriceFor(i) });
    return out;
}

// What the calibration measures: the same pairs in the shape
// `OraclePublisher._bufferEntryFromEvent` produces ({pair, price}), carrying the
// FINALIZED eight-decimal spelling rather than the submitted one.
function bufferedPairSet(pairCount) {
    const out = [];
    for (let i = 0; i < pairCount; i++) {
        out.push({ pair: NAMES[i], price: pairPriceFor(i) + '.00000000' });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Reading a landed batch wire
// ---------------------------------------------------------------------------

// Helper gap 1 (see the header): `drive.parsePriceBatchWire` still gates on
// version 2. Same field walk, same consensus inflate, version 0.
function readBatchWire(wire) {
    const parts = String(wire || '').split('|');
    if (parts[0] !== 'PRICE') return { ok: false, reason: 'not-a-price-wire' };
    const version = parseInt(parts[1], 10);
    if (version !== 0) return { ok: false, reason: 'not-version-0', version: version };

    let body, compressed = false, compressedBytes = null, ratio = null;
    if (parts[2] === drive.priceBatch.PRICE_BATCH_COMPRESSION_MARKER) {
        // Rejoining is required, not cosmetic: base64 carries no `|`, but a
        // malformed wire may, and rejoining is what makes this reader see the same
        // field the indexer sees.
        const field    = parts.slice(3).join('|');
        const inflated = drive.priceBatch.inflatePriceBatchBody(field);
        if (!inflated.ok) {
            return { ok: false, reason: inflated.reason, status: inflated.status, compressed: true };
        }
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
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        wireBytes: Buffer.byteLength(String(wire), 'utf8'),
        compressedBytes: compressedBytes, ratio: ratio,
        firstRound: firstRound, lastRound: lastRound, anchor: anchor,
        roundCount: roundCount, rounds: rounds, sigs: sigs
    };
}

// ---------------------------------------------------------------------------

describe('AT3 oracle batch splitting and the wire ceiling on DOGE regtest (L3)', function () {
    // Eight PBFT rounds over hundreds of pairs, four signing rounds, four encoder
    // builds and four confirmations on a real chain, plus one deliberately
    // oversized round. The budget is per-suite; every wait inside is a poll that
    // returns the moment its condition holds.
    this.timeout(120 * 60 * 1000);

    let venue = null, pinned = null, signerSet = null;

    // Calibration, measured against the publisher's own packer before any round runs.
    let calib = null;

    // Driven rounds, per window.
    let roundsA = [], roundsB = [];

    // Publications, split by the phase they arrived in.
    let pubsA = [], pubsB = [];
    let wiresA = [], wiresB = [];
    let landedA = [], landedB = [];      // { pub, parsed, indexed, block }
    let settleA = null, settleB = null;

    // Publisher counters snapshotted at the end of each phase.
    let statsAfterA = null, statsAfterB = null;

    // Everything console.error saw while the rail was live.
    let errorLines = [];
    let origConsoleError = null;

    // Dead-letter records found across every hub's own dead-letter file.
    let deadLetters = [];

    // Non-fatal problems recorded during before(), surfaced by the assertions that
    // depend on them rather than aborting the whole run in a hook.
    let notes = [];

    // Sum a batch counter across every publisher in the federation. Window A and
    // window B elect DIFFERENT leaders (leaderRank = windowIndex % publisherCount),
    // so no single hub holds both halves of AT3.
    function sumStat(stats, key) {
        return stats.reduce((acc, s) => acc + (Number(s[key]) || 0), 0);
    }

    function roundsOn(parsedWires) {
        const out = [];
        for (const p of parsedWires) if (p && p.ok) for (const r of p.rounds) out.push(r.round);
        return out.sort((a, b) => a - b);
    }

    before(async function () {
        pinned = drive.pinBatchWindow({ windowRounds: WINDOW_ROUNDS, graceMs: GRACE_MS });
        venue = new OracleBatchVenue({
            coin: 'dogecoin', network: 'regtest',
            validatorCount: VALIDATORS,
            basePort: 33940,
            roundBase: drive.alignedRoundBase(WINDOW_ROUNDS),
            // Multi-kilobyte wires ride as chunked P2SH, which costs more dust and
            // more fee per transaction than AT1's single 586-byte wire did.
            fundAmount: 1000,
            expectWireVersion: 0
        });

        let up = false;
        try { up = await venue.up(); }
        catch (err) {
            console.log('AT3 venue unavailable: ' + (err && err.message));
            await venue.down(); venue = null; pinned.restore();
            this.skip(); return;
        }
        if (!up) {
            console.log('AT3 venue unavailable: ' + venue.unavailable);
            await venue.down(); venue = null; pinned.restore();
            this.skip(); return;
        }

        // ---- helper gap 2: give every hub its own batch buffer ----------------
        // Done BEFORE any round is driven, so nothing this drill finalizes has been
        // buffered yet and dropping the hydrated map loses nothing of this run's.
        for (let i = 0; i < venue.publishers.length; i++) {
            const pub = venue.publishers[i];
            pub.bufferPath = path.join(venue._queueDir, 'publisher-queue-' + i + '.buffer.jsonl');
            pub._buffer    = new Map();
        }

        // ---- capture the loud half of the ceiling -----------------------------
        origConsoleError = console.error;
        console.error = function (...args) {
            try { errorLines.push(util.format(...args)); } catch (_) { /* capture is best effort */ }
            return origConsoleError.apply(console, args);
        };

        // Every hub, not just the leader: OraclePublisher constructs a signer lazily
        // and only the elected leader reaches that code, so without this no follower
        // has registered the XPRICEB handler and every signing round expires short.
        signerSet = drive.attachBatchSigners(venue);

        // ---- the pair set: real pairs first, synthetic overflow after ---------
        const built = buildNames(venue);
        NAMES = built.names;
        assert.ok(NAMES.length >= NAME_POOL, 'the pair-name pool did not build');

        // ---- calibration, against the REAL packer -----------------------------
        const pub = venue.publishers[0];

        // The same hint the publisher will size against (`_priceSetSizeHint`), so the
        // pair counts chosen here are the ones `_packSegment` will judge.
        let sigHint = VALIDATORS;
        try { sigHint = await pub._priceSetSizeHint(venue.anchorHeight, VALIDATORS); }
        catch (e) { notes.push('_priceSetSizeHint threw (' + (e && e.message) + '); falling back to ' + VALIDATORS); }
        const sigMax = Math.max(1, sigHint, VALIDATORS);

        const measure = (roundCount, pairCount, sigCount) => {
            const pairs  = bufferedPairSet(pairCount);
            const rounds = [];
            for (let k = 0; k < roundCount; k++) {
                rounds.push({
                    round:          venue.roundBase + k,
                    timestamp:      venue.anchorTimeBase + k * 600,
                    btcBlockHeight: venue.anchorHeight,
                    pairs:          pairs
                });
            }
            const emitted = pub._emitWire(
                rounds[0].round, rounds[rounds.length - 1].round,
                venue.anchorHeight, rounds, pub._placeholderSigs(sigCount));
            return {
                fits:       pub._wireFits(emitted),
                bodyBytes:  emitted.bodyBytes,
                wireBytes:  emitted.bytes,
                compressed: emitted.compressed
            };
        };

        // Both predicates are monotone in the pair count (the body grows strictly),
        // so a binary search is exact rather than a sample.
        const largestFitting = (roundCount, sigCount, lo, hi) => {
            let best = lo - 1;
            while (lo <= hi) {
                const m = (lo + hi) >> 1;
                if (measure(roundCount, m, sigCount).fits) { best = m; lo = m + 1; } else { hi = m - 1; }
            }
            return best;
        };
        const smallestNotFitting = (roundCount, sigCount, lo, hi) => {
            let best = hi + 1;
            while (lo <= hi) {
                const m = (lo + hi) >> 1;
                if (!measure(roundCount, m, sigCount).fits) { best = m; hi = m - 1; } else { lo = m + 1; }
            }
            return best;
        };

        // TWO rounds must fit even with the largest signature set the federation can
        // return; THREE must not fit even with a single signature, so the split is a
        // statement about round data rather than about how many peers co-signed.
        const hiTwo   = largestFitting(2, sigMax, 4, 900);
        const loThree = smallestNotFitting(3, 1, 4, 900);
        // ONE round must not fit even with a single signature.
        const loOne   = smallestNotFitting(1, 1, 4, 1600);

        const pairsMid = (loThree <= hiTwo) ? Math.floor((loThree + hiTwo) / 2) : null;
        const pairsBig = Math.min(1600, Math.ceil(loOne * 1.25));

        calib = {
            sigHint: sigHint, sigMax: sigMax,
            realPairs: built.realCount,
            hiTwo: hiTwo, loThree: loThree, loOne: loOne,
            pairsMid: pairsMid, pairsBig: pairsBig,
            mid1: pairsMid === null ? null : measure(1, pairsMid, sigMax),
            mid2: pairsMid === null ? null : measure(2, pairsMid, sigMax),
            mid3: pairsMid === null ? null : measure(3, pairsMid, 1),
            big1: measure(1, pairsBig, 1),
            big1Max: measure(1, pairsBig, sigMax)
        };

        console.log('\n  --- AT3: calibration against the real packer ---');
        console.log('  canonical pairs priced: ' + built.realCount + ' (' + NAMES.slice(0, 3).join(', ') +
            ', ...); synthetic overflow beyond that starts at ' + NAMES[built.realCount]);
        console.log('  signature-set hint: ' + sigHint + ' (sizing against ' + sigMax + ')');
        console.log('  largest pair count where 2 rounds fit: ' + hiTwo);
        console.log('  smallest pair count where 3 rounds do NOT fit: ' + loThree);
        console.log('  smallest pair count where 1 round does NOT fit: ' + loOne);
        console.log('  chosen: pairsMid=' + pairsMid + '  pairsBig=' + pairsBig);
        if (calib.mid2) {
            console.log('    mid x1: body ' + calib.mid1.bodyBytes + 'B wire ' + calib.mid1.wireBytes +
                'B fits=' + calib.mid1.fits);
            console.log('    mid x2: body ' + calib.mid2.bodyBytes + 'B wire ' + calib.mid2.wireBytes +
                'B fits=' + calib.mid2.fits);
            console.log('    mid x3: body ' + calib.mid3.bodyBytes + 'B wire ' + calib.mid3.wireBytes +
                'B fits=' + calib.mid3.fits);
        }
        console.log('    big x1: body ' + calib.big1.bodyBytes + 'B wire ' + calib.big1.wireBytes +
            'B compressed=' + calib.big1.compressed + ' fits=' + calib.big1.fits);
        console.log('  -----------------------------------------------\n');

        if (pairsMid === null) {
            notes.push('no pair count satisfies "2 rounds fit AND 3 rounds do not"; the wire bound moved');
            return;   // the calibration assertion below reports this precisely
        }

        // ---- widen the co-sign whitelist to cover the synthetic overflow -------
        // `OracleConsensus._handlePropose` refuses to co-sign any pair outside
        // `oracleRound.canonicalPairs`, on EVERY follower, so without this a synthetic
        // pair does not merely get dropped: the whole round is withheld and there is no
        // batch to split. Applied to every hub, before any round is driven, and to the
        // exact name set this run prices and nothing wider.
        const widenTo = Math.max(pairsMid, pairsBig);
        for (const o of venue._oracles) {
            for (let i = 0; i < widenTo; i++) o.round.canonicalPairs.add(NAMES[i]);
        }
        console.log('  co-sign whitelist widened to ' + widenTo + ' pair(s) on ' +
            venue._oracles.length + ' hub(s)\n');

        const driveRound = (index, pairCount) => drive.finalizeRoundNoWait(
            venue, index, { prices: submissionSet(pairCount), timeoutMs: 300_000 });

        // ---- WINDOW A: an overflowing window that splits ----------------------
        for (let i = 0; i < WINDOW_ROUNDS; i++) roundsA.push(await driveRound(i, pairsMid));

        settleA = await drive.waitForPublications(
            venue, { min: 2, quietMs: 30_000, timeoutMs: 45 * 60 * 1000 });
        pubsA = venue.publications.slice(0);
        statsAfterA = venue.publisherStats();
        console.log('  AT3 window A settled: reached=' + settleA.reached + ' settled=' + settleA.settled +
            ' publications=' + pubsA.length);

        // ---- WINDOW B: the same window shape with ONE unfittable round --------
        // Index 6 is the third round of window B, so the packer meets it AFTER it has
        // already packed and published rounds 4-5, and it still has round 7 to pack
        // afterwards. That ordering is what makes "isolated, not poisoning" testable.
        const BIG_INDEX = WINDOW_ROUNDS + 2;
        for (let i = WINDOW_ROUNDS; i < WINDOW_ROUNDS * 2; i++) {
            roundsB.push(await driveRound(i, i === BIG_INDEX ? pairsBig : pairsMid));
        }

        settleB = await drive.waitForPublications(
            venue, { min: pubsA.length + 2, quietMs: 30_000, timeoutMs: 45 * 60 * 1000 });
        pubsB = venue.publications.slice(pubsA.length);
        statsAfterB = venue.publisherStats();
        console.log('  AT3 window B settled: reached=' + settleB.reached + ' settled=' + settleB.settled +
            ' publications=' + venue.publications.length + ' (window B: ' + pubsB.length + ')');

        // ---- read everything back off the chain -------------------------------
        const readBack = async (list, into, parsedInto) => {
            for (const p of list) {
                const parsed = readBatchWire(p.wire);
                parsedInto.push(parsed);
                let indexed = null, block = null;
                try { indexed = await venue.readIndexedPrice(p.txid); }
                catch (e) { notes.push('readIndexedPrice(' + p.txid + ') failed: ' + (e && e.message)); }
                try { block = await venue.blockOf(p.txid); }
                catch (e) { notes.push('blockOf(' + p.txid + ') failed: ' + (e && e.message)); }
                into.push({ pub: p, parsed: parsed, indexed: indexed, block: block });
            }
        };
        await readBack(pubsA, landedA, wiresA);
        await readBack(pubsB, landedB, wiresB);

        // ---- the dead-letter files, across every hub --------------------------
        for (const s of statsAfterB) {
            let raw = '';
            try { raw = fs.readFileSync(s.deadLetterPath, 'utf8'); }
            catch (e) { continue; }   // no file means this hub abandoned nothing
            for (const line of raw.split('\n')) {
                if (!line.trim()) continue;
                try { deadLetters.push(Object.assign(JSON.parse(line), { _file: s.deadLetterPath })); }
                catch (e) { notes.push('unparseable dead-letter line in ' + s.deadLetterPath); }
            }
        }

        console.log('\n  --- AT3: what actually landed ---');
        console.log('  window A rounds: ' + roundsA.map((r) => r.round).join(', ') +
            '   (' + pairsMid + ' pairs each)');
        console.log('  window B rounds: ' + roundsB.map((r) => r.round).join(', ') +
            '   (' + pairsMid + ' pairs each, except round ' + (venue.roundBase + BIG_INDEX) +
            ' at ' + pairsBig + ')');
        for (const l of landedA.concat(landedB)) {
            console.log('    hub ' + l.pub.hubIndex + '  v' + l.pub.wireVersion + '  wire ' +
                l.pub.wireBytes + 'B  ' + l.pub.encoding + '  tx ' + l.pub.txid +
                '  block ' + (l.block ? l.block.height : '?') +
                (l.parsed.ok
                    ? ('  rounds [' + l.parsed.firstRound + '..' + l.parsed.lastRound + '] count ' +
                       l.parsed.roundCount + ' body ' + l.parsed.bodyBytes + 'B compressed=' +
                       l.parsed.compressed + ' sigs ' + l.parsed.sigs.length)
                    : ('  UNPARSEABLE: ' + l.parsed.reason)) +
                (l.indexed ? ('  -> ' + l.indexed.status) : '  -> NO PRICES ROW'));
        }
        console.log('  batchSplitCount total:         ' + sumStat(statsAfterB, 'batchSplitCount'));
        console.log('  batchUnpublishableCount total: ' + sumStat(statsAfterB, 'batchUnpublishableCount') +
            '  (after window A: ' + sumStat(statsAfterA, 'batchUnpublishableCount') + ')');
        console.log('  dead-letter records: ' + deadLetters.length);
        for (const d of deadLetters) {
            console.log('    round ' + d.round + ' [' + d.batchFirstRound + '..' + d.batchLastRound +
                ']  reason: ' + d.reason);
        }
        console.log('  CRITICAL lines: ' + errorLines.filter((l) => l.indexOf('CRITICAL') !== -1).length);
        for (const l of errorLines.filter((x) => x.indexOf('CRITICAL') !== -1)) {
            console.log('    ' + l.split('\n')[0]);
        }
        if (notes.length > 0) console.log('  notes: ' + notes.join(' | '));
        console.log(drive.railDiagnosis(venue, signerSet));
        console.log('  ---------------------------------\n');
    });

    after(async function () {
        if (origConsoleError) { console.error = origConsoleError; origConsoleError = null; }
        if (signerSet) signerSet.stop();
        if (venue) await venue.down();
        if (pinned) pinned.restore();
    });

    it('the overflow premise is the publisher\'s OWN bound, measured not assumed', function () {
        assert.ok(calib, 'the calibration never ran; the venue did not come up');
        // The overflow is filler ON TOP OF the real feed, not instead of it: if the
        // canonical set ever stopped reaching the venue, every round here would be
        // synthetic and the drill would quietly stop resembling a real window.
        assert.ok(calib.realPairs >= 30,
            'only ' + calib.realPairs + ' canonical pair(s) reached the venue, so these rounds are ' +
            'almost entirely synthetic; the federation prices 36 and this drill holds out 2');
        assert.ok(calib.pairsMid === null || calib.pairsMid > calib.realPairs,
            'the calibrated pair count (' + calib.pairsMid + ') does not exceed the canonical set (' +
            calib.realPairs + '), so no overflow filler was needed and the premise is untested');
        assert.ok(calib.pairsMid !== null,
            'no pair count satisfies "2 rounds fit AND 3 rounds do not" anywhere in 4..900 pairs. ' +
            'The largest pair count where 2 rounds fit is ' + calib.hiTwo + ' and the smallest where ' +
            '3 rounds do not is ' + calib.loThree + '. AT3 is unforceable on this wire bound, which ' +
            'means the bound moved, not that the rail broke.');
        assert.strictEqual(calib.mid2.fits, true,
            'two ' + calib.pairsMid + '-pair rounds do not fit one wire (body ' + calib.mid2.bodyBytes +
            'B, wire ' + calib.mid2.wireBytes + 'B); window A would then split one-round-per-wire and ' +
            'prove nothing about range packing');
        assert.strictEqual(calib.mid3.fits, false,
            'three ' + calib.pairsMid + '-pair rounds DO fit one wire (body ' + calib.mid3.bodyBytes +
            'B); window A would publish a single wire and there would be no split to observe');
        assert.strictEqual(calib.big1.fits, false,
            'one ' + calib.pairsBig + '-pair round fits a wire on its own (body ' + calib.big1.bodyBytes +
            'B, wire ' + calib.big1.wireBytes + 'B); there is no ceiling case to reach');
        // The interesting half of section 8, asserted rather than asserted-about: the
        // oversized round's EMITTED wire is comfortably legal and its INFLATED body is
        // not, so what refuses it is the reader's cap. Compression buys fee, not capacity.
        assert.ok(calib.big1.bodyBytes > WIRE_MAX_BYTES,
            'the oversized round\'s uncompressed body is ' + calib.big1.bodyBytes + 'B, which is not ' +
            'over the ' + WIRE_MAX_BYTES + 'B reader cap; the ceiling would then be a compression ' +
            'artifact rather than a capacity fact');
    });

    it('all eight rounds finalized on a real multi-signature quorum', function () {
        const all = roundsA.concat(roundsB);
        assert.strictEqual(all.length, WINDOW_ROUNDS * 2,
            'expected ' + (WINDOW_ROUNDS * 2) + ' finalized rounds, got ' + all.length);
        for (const r of all) {
            const distinct = new Set(r.signatures.map((s) => String(s.pubkey).toLowerCase()));
            assert.ok(distinct.size >= MIN_SIGNATURES,
                'CONSENSUS rung: round ' + r.round + ' finalized on only ' + distinct.size +
                ' distinct signer(s); a weighted quorum over ' + VALIDATORS + ' equal sources needs ' +
                MIN_SIGNATURES + '. Nothing downstream of this can be read.' +
                drive.railDiagnosis(venue, signerSet));
        }
    });

    it('the overflowing window published as SPLIT batches, packed by range', function () {
        assert.ok(settleA && settleA.reached,
            'no wire was ever broadcast for the overflowing window. Read the rail state: signRounds 0 ' +
            'means the leader never proposed (leader election or the window self-check); signTimeouts > 0 ' +
            'means it proposed and no quorum answered; unpublishable > 0 means the packer never found a ' +
            'range that fits, which would make the calibration wrong.' + drive.railDiagnosis(venue, signerSet));
        assert.strictEqual(pubsA.length, 2,
            'window A carried ' + WINDOW_ROUNDS + ' rounds that cannot share one wire, so the packer ' +
            'must emit exactly two; it emitted ' + pubsA.length + '. One means the overflow never ' +
            'happened (read the calibration above); more than two means the packer degenerated below ' +
            'the range the calibration says fits.' + drive.railDiagnosis(venue, signerSet));
        assert.ok(settleA.settled,
            'a third wire was still arriving when the quiet window expired, so "exactly two" is a race ' +
            'this run happened to win rather than a property.' + drive.railDiagnosis(venue, signerSet));
        assert.ok(sumStat(statsAfterA, 'batchSplitCount') >= 1,
            'two wires were emitted for one window but batchSplitCount is ' +
            sumStat(statsAfterA, 'batchSplitCount') + '; the split counter is the machine-checkable ' +
            'half of the claim and it did not move');

        for (const p of wiresA) {
            assert.ok(p.ok, 'a window A wire does not parse as a PRICE batch: ' + p.reason);
            assert.strictEqual(p.roundCount, 2,
                'a window A wire carries ' + p.roundCount + ' round(s); the calibration says exactly ' +
                'two fit, so a 1-round wire means the packer under-filled and a 3-round wire means it ' +
                'over-filled past the bound it measures against');
            assert.ok(p.bodyBytes <= WIRE_MAX_BYTES,
                'a window A wire carries a ' + p.bodyBytes + '-byte inflated body, over the ' +
                WIRE_MAX_BYTES + '-byte reader cap: a DOGE fee paid on an action no indexing node ' +
                'will finish inflating');
            // Section 4: the batch header anchor IS the last included round's own anchor.
            assert.strictEqual(p.anchor, p.rounds[p.rounds.length - 1].btcBlockHeight,
                'a split wire\'s header anchor was not re-derived for its sub-range; both verifiers ' +
                'reject that wire');
            const distinct = new Set(p.sigs.map((s) => s.pubkey));
            assert.strictEqual(distinct.size, p.sigs.length, 'a window A wire carries a duplicate signer');
            assert.ok(distinct.size >= MIN_SIGNATURES,
                'SIGNING ROUND rung: a split wire carries only ' + distinct.size + ' signature(s); each ' +
                'sub-range is separately proposed and separately co-signed, so a short set means peers ' +
                'could not reproduce THAT range from their own price_snapshots' +
                drive.railDiagnosis(venue, signerSet));
        }

        // The split is a partition: every driven round on exactly one wire, in order,
        // with no round duplicated across wires and none dropped between them.
        assert.deepStrictEqual(roundsOn(wiresA), roundsA.map((r) => r.round),
            'the two split wires cover [' + roundsOn(wiresA).join(', ') + '] but the federation ' +
            'finalized [' + roundsA.map((r) => r.round).join(', ') + ']. A split that loses or ' +
            'duplicates a round is not a split.');
        const ranges = wiresA.map((p) => [p.firstRound, p.lastRound]).sort((a, b) => a[0] - b[0]);
        assert.ok(ranges[0][1] < ranges[1][0],
            'the split wires\' declared windows overlap ([' + ranges[0].join('..') + '] and [' +
            ranges[1].join('..') + ']); two batches claiming one round is the false-equivocation shape');
    });

    it('every split wire LANDED: mined, parsed and stored by the landing chain', function () {
        assert.strictEqual(landedA.length, 2, 'window A produced ' + landedA.length + ' publications');
        for (const l of landedA) {
            assert.ok(/^[0-9a-f]{64}$/.test(String(l.pub.txid)),
                'PUSH rung: the publish returned ' + l.pub.txid + ' rather than a transaction id');
            assert.ok(l.block && Number.isFinite(Number(l.block.height)),
                'PUSH rung: transaction ' + l.pub.txid + ' is not in a block on the ' + venue.rail.code +
                ' node, so "they all land" is unproven for it. ' + notes.join(' | '));
            assert.ok(l.indexed,
                'PARSE rung: the ' + venue.rail.code + ' indexer wrote no prices row for ' + l.pub.txid);
            assert.strictEqual(Number(l.indexed.version), 0,
                'PARSE rung: the indexer recorded PRICE version ' + l.indexed.version + ' for a batch wire');
            assert.strictEqual(Number(l.indexed.batch_first_round), l.parsed.firstRound,
                'PARSE rung: the indexer stored batch_first_round ' + l.indexed.batch_first_round +
                ' for a wire whose FIRST_ROUND is ' + l.parsed.firstRound);
            assert.strictEqual(Number(l.indexed.batch_last_round), l.parsed.lastRound);
            assert.strictEqual(Number(l.indexed.round_count), l.parsed.roundCount,
                'PARSE rung: the indexer stored round_count ' + l.indexed.round_count + ' for a ' +
                l.parsed.roundCount + '-round batch');
            assert.strictEqual(Number(l.indexed.round_number), l.parsed.firstRound,
                'D21: a batch row carries FIRST_ROUND in round_number');
            const stored = JSON.parse(l.indexed.rounds_json || '[]');
            assert.strictEqual(stored.length, l.parsed.roundCount,
                'PARSE rung: rounds_json holds ' + stored.length + ' round(s), not ' + l.parsed.roundCount);
            // A split wire must not be silently downgraded to some other failure: the
            // only two verdicts a well-formed batch may record here are "valid" and the
            // known off-BTC capability status.
            const status = String(l.indexed.status);
            assert.ok(status === 'valid' || status === KNOWN_CAPABILITY_GAP_STATUS,
                'SIGNER RESOLUTION rung: a split wire indexed as "' + status + '". Expected either ' +
                '"valid" or the known capability-gap status "' + KNOWN_CAPABILITY_GAP_STATUS + '". ' +
                'Anything else is a parse, fee or wire regression, not the known gap.' +
                drive.railDiagnosis(venue, signerSet));
        }
    });

    it('the round that cannot fit incremented batchUnpublishableCount', function () {
        assert.strictEqual(sumStat(statsAfterA, 'batchUnpublishableCount'), 0,
            'batchUnpublishableCount was already ' + sumStat(statsAfterA, 'batchUnpublishableCount') +
            ' after window A, which published cleanly. The counter must be moved by the oversized ' +
            'round in window B and by nothing else, or the assertion below measures the wrong event.');
        assert.strictEqual(sumStat(statsAfterB, 'batchUnpublishableCount'), 1,
            'exactly ONE round in this run cannot fit any wire form, so the federation-wide ' +
            'batchUnpublishableCount must be 1; it is ' +
            sumStat(statsAfterB, 'batchUnpublishableCount') + '. Zero means the leader never reached ' +
            'the ceiling path at all: check signRounds and signTimeouts below, because the counter ' +
            'is incremented AFTER the signing round returns quorum.' +
            drive.railDiagnosis(venue, signerSet));
    });

    it('the round that cannot fit was DEAD-LETTERED with its content and its reason', function () {
        const bigRound = venue.roundBase + WINDOW_ROUNDS + 2;
        const mine = deadLetters.filter((d) => Number(d.round) === bigRound);
        assert.strictEqual(mine.length, 1,
            'expected exactly one dead-letter record for round ' + bigRound + ', found ' + mine.length +
            ' (across ' + deadLetters.length + ' record(s) in total: ' +
            deadLetters.map((d) => d.round + '/' + d.reason).join(' ; ') + ')');
        const rec = mine[0];
        assert.ok(/exceeds encoder limit/i.test(String(rec.reason)),
            'the dead-letter reason is "' + rec.reason + '", which does not name the size refusal; an ' +
            'operator reading this file must be able to tell a ceiling breach from an attempts-exhausted ' +
            'abandon');
        assert.strictEqual(Number(rec.batchFirstRound), bigRound,
            'the dead-letter record claims window [' + rec.batchFirstRound + '..' + rec.batchLastRound +
            '], but the ceiling case is reached only for a SINGLE round');
        assert.strictEqual(Number(rec.batchLastRound), bigRound);
        // The record has to be replayable, which means it carries the round, not a
        // pointer to it.
        assert.ok(Array.isArray(rec.rounds) && rec.rounds.length === 1,
            'the dead-letter record carries ' + (rec.rounds ? rec.rounds.length : 'no') + ' round ' +
            'bodies; an operator cannot replay a round the file does not contain');
        assert.ok(Array.isArray(rec.rounds[0].pairs) && rec.rounds[0].pairs.length === calib.pairsBig,
            'the dead-lettered round carries ' +
            (rec.rounds[0].pairs ? rec.rounds[0].pairs.length : 'no') + ' pairs, not the ' +
            calib.pairsBig + ' the federation finalized for it');
        assert.ok(Array.isArray(rec.sigs) && rec.sigs.length >= MIN_SIGNATURES,
            'the dead-lettered round carries ' + (rec.sigs ? rec.sigs.length : 'no') + ' signature(s); ' +
            'the ceiling is reached only AFTER quorum, so a short set means something else refused it');
    });

    it('the ceiling was LOUD: a CRITICAL line naming the round and the bound it breached', function () {
        const bigRound = venue.roundBase + WINDOW_ROUNDS + 2;
        const criticals = errorLines.filter((l) => /OraclePublisher: CRITICAL/.test(l));
        assert.ok(criticals.length >= 1,
            'the rail refused a round and logged no CRITICAL line at all. The counter and the ' +
            'dead-letter are machine-checkable, but section 8 makes the log line the deliverable an ' +
            'operator actually sees, and the hub has no other alerting rail. Lines captured: ' +
            errorLines.length);
        const named = criticals.filter((l) => l.indexOf(String(bigRound)) !== -1);
        assert.ok(named.length >= 1,
            'a CRITICAL line was logged but none names round ' + bigRound + '; an alert that does not ' +
            'say WHICH round is unpublishable cannot be acted on. Captured CRITICAL lines: ' +
            criticals.map((l) => l.split('\n')[0]).join(' || '));
        assert.ok(/8189/.test(named[0]) && /does not fit/i.test(named[0]),
            'the CRITICAL line for round ' + bigRound + ' does not state the byte limit it breached: "' +
            named[0].split('\n')[0] + '"');
    });

    it('the unfittable round poisoned nothing: its window still published its neighbours', function () {
        const bigRound = venue.roundBase + WINDOW_ROUNDS + 2;
        const expected = roundsB.map((r) => r.round).filter((r) => r !== bigRound);

        assert.ok(settleB && settleB.settled,
            'window B was still emitting wires when the quiet window expired, so what it published is ' +
            'a snapshot of a race rather than the window\'s result.' + drive.railDiagnosis(venue, signerSet));
        assert.strictEqual(pubsB.length, 2,
            'window B holds three publishable rounds around one unpublishable one, so the packer must ' +
            'emit two wires ([' + expected.slice(0, 2).join(',') + '] and [' + expected[2] + ']); it ' +
            'emitted ' + pubsB.length + '. Zero means the ceiling aborted the whole window, which is ' +
            'the failure mode this assertion exists to catch.' + drive.railDiagnosis(venue, signerSet));

        for (const p of wiresB) assert.ok(p.ok, 'a window B wire does not parse: ' + p.reason);
        assert.deepStrictEqual(roundsOn(wiresB), expected,
            'window B published rounds [' + roundsOn(wiresB).join(', ') + ']; expected [' +
            expected.join(', ') + '], i.e. every finalized round except the unpublishable one');

        // The strongest form of "it never reached the chain": no wire this federation
        // emitted, in either window, carries it.
        const everything = roundsOn(wiresA.concat(wiresB));
        assert.strictEqual(everything.indexOf(bigRound), -1,
            'round ' + bigRound + ' was declared unpublishable and dead-lettered, yet it rode a wire ' +
            'anyway. That is a DOGE fee spent on an action every indexing node refuses to inflate.');

        for (const l of landedB) {
            assert.ok(l.block && Number.isFinite(Number(l.block.height)),
                'PUSH rung: window B transaction ' + l.pub.txid + ' is not in a block');
            assert.ok(l.indexed, 'PARSE rung: no prices row for window B transaction ' + l.pub.txid);
            assert.strictEqual(Number(l.indexed.batch_first_round), l.parsed.firstRound);
            assert.strictEqual(Number(l.indexed.batch_last_round), l.parsed.lastRound);
            assert.strictEqual(Number(l.indexed.round_count), l.parsed.roundCount);
        }
    });
});
