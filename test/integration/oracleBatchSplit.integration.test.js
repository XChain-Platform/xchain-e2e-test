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
 * is a module-level const in `xchain-hub/src/oracle/publisher.js:92`; neither the
 * constructor nor any of the four `ORACLE_BATCH_*` knobs exposes it, and the two
 * env knobs that DO exist (`ORACLE_BATCH_WINDOW_ROUNDS`, `ORACLE_BATCH_GRACE_MS`)
 * change cadence, not capacity. So there is no limit to inject, and lowering one
 * by monkey-patching `wireFits` would replace the predicate under test with a
 * test-authored one. Instead the rounds are made genuinely large: real pairs,
 * really aggregated by a real trimmed median on four real validators, really
 * signed by a real quorum, really packed by `packSegment` against the real
 * `emitWire`/`wireFits` pair, and really refused at the real 8,189-byte bound.
 *
 * The pair counts are not guessed. Before a single round is driven, this drill
 * CALIBRATES them by binary search against the publisher's OWN `emitWire`,
 * `placeholderSigs` and `wireFits` on the venue's own publisher instance, so
 * the sizes it picks are the sizes that class will measure later. The calibration
 * is then re-asserted as evidence in its own `it()`: if a future encoder or
 * compression change moves the bound, this drill says the premise moved rather
 * than reporting a rail failure.
 *
 * WHICH BOUND ACTUALLY BINDS, and it is the interesting half of section 8. These
 * bodies compress extremely well, so the emitted wire is far under the encoder's
 * payload limit while the INFLATED body is far over the reader's cap. `wireFits`
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
 * any round runs: `OracleConsensus.handlePropose` refuses to co-sign a pair
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

const util   = require('util');
const path   = require('path');

const { OracleBatchVenue } = require('../helpers/oracleBatchVenue');
const drive = require('../helpers/oracleBatchDrive');
const pairs = require('./oracleBatchSplit.integration.test/helpers/pairs');
const { calibrate } = require('./oracleBatchSplit.integration.test/helpers/calibrate');
const windows = require('./oracleBatchSplit.integration.test/helpers/windows');
const { WINDOW_ROUNDS, VALIDATORS, GRACE_MS, NAME_POOL } = pairs;

// Brings the venue up, or returns false (after cleanup) when it is unavailable.
async function bringUpVenue(ctx) {
    ctx.pinned = drive.pinBatchWindow({ windowRounds: WINDOW_ROUNDS, graceMs: GRACE_MS });
    ctx.venue = new OracleBatchVenue({
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
    try { up = await ctx.venue.up(); }
    catch (err) { console.log('AT3 venue unavailable: ' + (err && err.message)); }
    if (!up) {
        if (ctx.venue.unavailable) console.log('AT3 venue unavailable: ' + ctx.venue.unavailable);
        await ctx.venue.down(); ctx.venue = null; ctx.pinned.restore();
    }
    return up;
}

// Helper gap 2: give every hub its own batch buffer. Done BEFORE any round is
// driven, so dropping the hydrated map loses nothing of this run's.
function isolateBuffers(venue) {
    for (let i = 0; i < venue.publishers.length; i++) {
        const pub = venue.publishers[i];
        pub.bufferPath = path.join(venue['_queueDir'], 'publisher-queue-' + i + '.buffer.jsonl');
        pub['_buffer']    = new Map();
    }
}

// Capture the loud half of the ceiling.
function captureConsoleError(ctx) {
    ctx.origConsoleError = console.error;
    console.error = function (...args) {
        try { ctx.errorLines.push(util.format(...args)); } catch (internal) { /* capture is best effort */ }
        return ctx.origConsoleError.apply(console, args);
    };
}

// Every phase of the drill, in order, once the venue is up.
async function runDrill(ctx) {
    const { venue } = ctx;
    isolateBuffers(venue);
    captureConsoleError(ctx);
    // Every hub, not just the leader: OraclePublisher constructs a signer lazily
    // and only the elected leader reaches that code, so without this no follower
    // has registered the XPRICEB handler and every signing round expires short.
    ctx.signerSet = drive.attachBatchSigners(venue);

    const built = pairs.buildNames(venue);
    pairs.setNames(built.names);
    if (built.names.length < NAME_POOL) throw new Error('the pair-name pool did not build');

    ctx.calib = await calibrate(venue, built.realCount, ctx.notes);
    const { pairsMid, pairsBig } = ctx.calib;
    if (pairsMid === null) {
        ctx.notes.push('no pair count satisfies "2 rounds fit AND 3 rounds do not"; the wire bound moved');
        return;   // the calibration assertion reports this precisely
    }
    windows.widenWhitelist(venue, Math.max(pairsMid, pairsBig));
    await windows.driveWindows(ctx);

    await windows.readBack(ctx, ctx.pubsA, ctx.landedA, ctx.wiresA);
    await windows.readBack(ctx, ctx.pubsB, ctx.landedB, ctx.wiresB);
    windows.collectDeadLetters(ctx);
    windows.logLanded(ctx);
}

describe('AT3 oracle batch splitting and the wire ceiling on DOGE regtest (L3)', function () {
    // Eight PBFT rounds over hundreds of pairs, four signing rounds, four encoder
    // builds and four confirmations on a real chain, plus one deliberately
    // oversized round. The budget is per-suite; every wait inside is a poll that
    // returns the moment its condition holds.
    this.timeout(120 * 60 * 1000);

    // Shared state: filled by before(), read by the parts below. Non-fatal problems
    // go to `notes` and are surfaced by the assertions that depend on them.
    const ctx = {
        venue: null, pinned: null, signerSet: null, calib: null,
        roundsA: [], roundsB: [], pubsA: [], pubsB: [],
        wiresA: [], wiresB: [], landedA: [], landedB: [],
        settleA: null, settleB: null, statsAfterA: null, statsAfterB: null,
        errorLines: [], origConsoleError: null, deadLetters: [], notes: []
    };

    before(async function () {
        if (!(await bringUpVenue(ctx))) { this.skip(); return; }
        await runDrill(ctx);
    });

    after(async function () {
        if (ctx.origConsoleError) { console.error = ctx.origConsoleError; ctx.origConsoleError = null; }
        if (ctx.signerSet) ctx.signerSet.stop();
        if (ctx.venue) await ctx.venue.down();
        if (ctx.pinned) ctx.pinned.restore();
    });

    require('./oracleBatchSplit.integration.test/01_the_split_window_published_as_ranges_that_landed.test')(ctx);
    require('./oracleBatchSplit.integration.test/02_the_unfittable_round_was_isolated_and_loud.test')(ctx);
});
