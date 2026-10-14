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

const mariadb = require('mariadb');

const { OracleBatchVenue }      = require('../../../helpers/oracleBatchVenue');
const { OracleBatchReplayNode } = require('../../../helpers/oracleBatchReplay');
const C = require('./constants');
const { drive, priceBatch, WINDOW_ROUNDS, VALIDATORS, GRACE_MS, PRICE_GRACE_S, GHOST_OFFSET,
    REASON_SIZE, REASON_RATIO, BATCH_WIRE_VERSION } = C;
const wire = require('./wire');
const chain = require('./chain');

// Every step takes the shared drill state `S`, fills in its slice, and returns
// false after tearing down when the venue is unavailable (the caller skips).

async function bail(S, why) {
    console.log('AT9 unavailable: ' + why);
    if (S.signerSet) { try { S.signerSet.stop(); } catch (internal) {} S.signerSet = null; }
    if (S.venue)      { await S.venue.down();      S.venue = null; }
    if (S.replayNode) { await S.replayNode.down(); S.replayNode = null; }
    if (S.liveNode)   { await S.liveNode.down();   S.liveNode = null; }
    if (S.pinned)     { S.pinned.restore();        S.pinned = null; }
    if (S.conn)       { try { await S.conn.end(); } catch (internal) {} S.conn = null; }
    if (S.hubDb)      { await S.hubDb.stop();      S.hubDb = null; }
}

async function teardown(S) {
    if (S.signerSet)  { try { S.signerSet.stop(); } catch (internal) {} }
    if (S.venue)      await S.venue.down();
    if (S.pinned)     S.pinned.restore();
    if (S.conn)       { try { await S.conn.end(); } catch (internal) {} }
    if (S.replayNode) await S.replayNode.down();
    if (S.liveNode)   await S.liveNode.down();
    if (S.hubDb)      await S.hubDb.stop();
}

async function startLiveNode(S) {
    // --- 1. the live node, caught up BEFORE anything is published ---------
    S.liveNode = new OracleBatchReplayNode({
        label: 'live', hubDb: S.hubDb, basePort: 61000, priceGraceS: PRICE_GRACE_S });
    let up = false;
    try { up = await S.liveNode.up(); }
    catch (err) { await bail(S, 'live node failed to build: ' + (err && err.message)); return false; }
    if (!up) { await bail(S, S.liveNode.unavailable); return false; }

    const tipBefore = (await S.liveNode.decoderHeight()).height;
    console.log('  AT9: live node built; catching up to chain block ' + tipBefore + '...');
    await S.liveNode.waitForHeight(tipBefore);
    return true;
}

async function publishWindow(S) {
    // --- 2. the federation publishes a REAL six-round batch ---------------
    S.pinned = drive.pinBatchWindow({ windowRounds: WINDOW_ROUNDS, graceMs: GRACE_MS });
    S.venue = new OracleBatchVenue({
        coin: 'dogecoin', network: 'regtest',
        validatorCount: VALIDATORS,
        basePort: 33900,
        roundBase: drive.alignedRoundBase(WINDOW_ROUNDS),
        expectWireVersion: BATCH_WIRE_VERSION
    });

    let venueUp = false;
    try { venueUp = await S.venue.up(); }
    catch (err) { await bail(S, 'publish venue failed to build: ' + (err && err.message)); return false; }
    if (!venueUp) { await bail(S, S.venue.unavailable); return false; }

    // Keep the batch BUFFER out of the checkout. OraclePublisher derives
    // bufferPath from queuePath in its CONSTRUCTOR and the venue redirects
    // queuePath afterwards, so the redirect never reaches the buffer: the rail
    // would write `<cwd>/data/publisher-queue.buffer.jsonl` into the working
    // tree and RELOAD a previous run's rounds into this one, where they would
    // fail their signing round.
    for (const pub of S.venue.publishers) {
        if (pub.queuePath) pub.bufferPath = String(pub.queuePath).replace(/\.jsonl$/, '') + '.buffer.jsonl';
        if (pub['_buffer'] && typeof pub['_buffer'].clear === 'function') pub['_buffer'].clear();
    }

    // Every hub, not just the leader: OraclePublisher builds its signer lazily
    // and only the leader reaches that code, so without this no follower has
    // registered the XPRICEB handler and the round expires at 1/3 sigs.
    S.signerSet = drive.attachBatchSigners(S.venue);

    S.rounds = await drive.finalizeRoundsNoWait(S.venue, WINDOW_ROUNDS);
    const settle = await drive.waitForPublications(S.venue, { min: 1, quietMs: 20_000, timeoutMs: 300_000 });
    S.railState = drive.railDiagnosis(S.venue, S.signerSet);

    if (!settle.reached || S.venue.publications.length === 0) {
        await bail(S, 'the window never produced a wire.' + S.railState); return false;
    }

    S.publicationCount = S.venue.publications.length;
    S.landedWire = S.venue.publications[0].wire;
    S.landedTxid = S.venue.publications[0].txid;
    S.parsedWire = wire.splitWire(S.landedWire);
    if (!S.parsedWire.ok) {
        await bail(S, 'the published wire does not read as a PRICE batch: ' +
            (S.parsedWire.reason || '?') + S.railState); return false;
    }
    S.parsedBody = wire.splitBody(S.parsedWire.body);
    return true;
}

async function deriveWindowFacts(S) {
    // The publisher's OWN builder, re-run over the content the wire carried.
    // Re-deriving the body in this file instead would compare the test to
    // itself; running the real builder is what makes "identical body" a claim
    // about the producer.
    S.rebuiltBody = S.venue.publishers[0].buildPriceBatchBody(
        S.parsedBody.firstRound, S.parsedBody.lastRound, S.parsedBody.anchor,
        S.parsedBody.rounds, S.parsedBody.sigs);

    // The literal round trip AT9 names: body -> deflate -> base64 -> parse ->
    // body, through the consensus module in both directions.
    S.reField    = priceBatch.compressPriceBatchBody(S.parsedWire.body);
    S.reInflated = priceBatch.inflatePriceBatchBody(S.reField);
    return true;
}

async function measureEmitSmaller(S) {
    // --- 3. the emit-smaller decision, driven both ways -------------------
    // The real publisher's real method. Called on the venue's own instance
    // rather than on a fresh one, so the decision measured is the decision the
    // rail makes.
    S.emitReal = S.venue.publishers[0].emitWire(
        S.parsedBody.firstRound, S.parsedBody.lastRound, S.parsedBody.anchor,
        S.parsedBody.rounds, S.parsedBody.sigs);

    // The same batch shape with incompressible content. Pair names and prices
    // are replaced with high-entropy strings; the ROUND/ANCHOR arithmetic is
    // left honest so `buildPriceBatchBody`'s anchor derivation still passes and
    // the body it produces is a real batch body in every structural respect.
    const entropyRounds = S.parsedBody.rounds.map((r) => ({
        round:          r.round,
        timestamp:      r.timestamp,
        btcBlockHeight: r.btcBlockHeight,
        // 32 and 64 characters rather than a realistic pair name's length, and
        // the reason is arithmetic. The body's numeric header (round numbers,
        // timestamps, anchors, counts) is ordinary compressible text, so it
        // works AGAINST the claim; the entropy has to outweigh it by roughly
        // 3.6 to 1 before the packed form loses. Measured at these lengths the
        // packed wire runs about 5% above the plain one, with the entropy
        // portion at ~1,900 B against ~150 B of header.
        pairs:          r.pairs.map(() => ({ coinPair: wire.entropyString(32), price: wire.entropyString(64) }))
    }));
    const entropySigs = S.parsedBody.sigs.map(() => ({ pubkey: wire.entropyString(64), sig: wire.entropyString(128) }));
    S.emitEntropy = S.venue.publishers[0].emitWire(
        S.parsedBody.firstRound, S.parsedBody.lastRound, S.parsedBody.anchor, entropyRounds, entropySigs);
    const entropyBody = S.venue.publishers[0].buildPriceBatchBody(
        S.parsedBody.firstRound, S.parsedBody.lastRound, S.parsedBody.anchor, entropyRounds, entropySigs);
    S.entropyPlainBytes  = Buffer.byteLength('PRICE|' + BATCH_WIRE_VERSION + '|' + entropyBody, 'utf8');
    S.entropyPackedBytes = Buffer.byteLength('PRICE|' + BATCH_WIRE_VERSION + '|' +
        priceBatch.PRICE_BATCH_COMPRESSION_MARKER + '|' +
        priceBatch.compressPriceBatchBody(entropyBody), 'utf8');
    return true;
}

async function craftHostileWires(S) {
    // --- 4. the hostile wires -------------------------------------------
    // A well-formed batch body over rounds this run has never finalized, built
    // by the publisher's own builder so it differs from an honest body in
    // nothing but its round numbers.
    const ghostRounds = S.parsedBody.rounds.map((r, i) => ({
        round:          S.venue.roundBase + GHOST_OFFSET + i,
        timestamp:      r.timestamp,
        btcBlockHeight: r.btcBlockHeight,
        pairs:          r.pairs.map((p) => ({ coinPair: p.pair, price: p.price }))
    }));
    S.ghost = {
        rounds: ghostRounds.map((r) => r.round),
        first:  ghostRounds[0].round,
        last:   ghostRounds[ghostRounds.length - 1].round,
        anchor: ghostRounds[ghostRounds.length - 1].btcBlockHeight
    };
    S.ghost.body = S.venue.publishers[0].buildPriceBatchBody(
        S.ghost.first, S.ghost.last, S.ghost.anchor, ghostRounds, S.parsedBody.sigs);

    S.breachSize  = wire.craftBreach(S.ghost.body, REASON_SIZE);
    // A ratio breach needs the deflated field under 55 bytes
    // (`ratioCap = compressed * 150` must fall at or below the 8189 size cap
    // for the RATIO reason to bind), which no body carrying real round data can
    // reach. The ratio case is therefore what it is in the wild: a pure bomb,
    // a payload that is nothing but compression.
    S.breachRatio = wire.craftBreach('', REASON_RATIO);

    const mutable = wire.craftMutableField(S.ghost.body);
    const spellingDefs = [
        { name: 'embedded whitespace', field: wire.spellWithWhitespace(mutable.field) },
        { name: 'URL-safe alphabet',   field: wire.spellUrlSafe(mutable.field) },
        { name: 'unused padding bits', field: wire.spellUnusedBits(mutable.field) }
    ];
    for (const s of spellingDefs) {
        if (s.field === null) {
            await bail(S, 'could not produce the "' + s.name + '" spelling from the compressed field'); return false;
        }
    }
    S.spellings = spellingDefs.map((s) => ({
        name: s.name,
        field: s.field,
        canonicalField: mutable.field,
        // What a LENIENT reader would make of this spelling. Captured before
        // anything is broadcast, because "not silently normalized" is only a
        // claim about spellings a lenient reader really does normalize.
        lenientDecodesSame: Buffer.from(s.field, 'base64')
            .equals(Buffer.from(mutable.field, 'base64')),
        strictRejects: priceBatch.decodeCanonicalBase64(s.field) === null
    }));
    return true;
}

async function landWires(S) {
    // --- 5. onto the chain, one at a time --------------------------------
    const marker = priceBatch.PRICE_BATCH_COMPRESSION_MARKER;
    S.breachSize.landed  = await chain.land(S, 'PRICE|' + BATCH_WIRE_VERSION + '|' + marker + '|' + S.breachSize.field,  'size-cap breach');
    S.breachRatio.landed = await chain.land(S, 'PRICE|' + BATCH_WIRE_VERSION + '|' + marker + '|' + S.breachRatio.field, 'ratio-cap breach');
    for (const s of S.spellings) {
        s.landed = await chain.land(S, 'PRICE|' + BATCH_WIRE_VERSION + '|' + marker + '|' + s.field, s.name);
    }
    // The honest batch's own plain twin: the SAME signed body in the other
    // wire form. This is what makes "publishes uncompressed" a statement about
    // the chain and not only about the emitter.
    S.plainTwin = await chain.land(S, 'PRICE|' + BATCH_WIRE_VERSION + '|' + S.parsedWire.body, 'uncompressed twin');

    const landedBlock = await S.venue.blockOf(S.landedTxid);
    if (landedBlock && Number(landedBlock.height) > S.targetHeight) S.targetHeight = Number(landedBlock.height);
    return true;
}

async function absorbOnLive(S) {
    // --- 6. the live node absorbs them, then the federation goes away -----
    await S.liveNode.waitForHeight(S.targetHeight);
    await chain.waitForPushDelivery(S.liveNode, 'live');

    S.conn = await mariadb.createConnection({
        host: S.hubDb.host, port: parseInt(S.hubDb.port, 10),
        user: S.hubDb.user, password: S.hubDb.pass, connectTimeout: 10_000
    });

    S.allTx = [S.landedTxid, S.breachSize.landed.txid, S.breachRatio.landed.txid,
                   S.plainTwin.txid].concat(S.spellings.map((s) => s.landed.txid));
    for (const txid of S.allTx) S.liveRows[txid] = await chain.waitForPriceRow(S.conn, S.liveNode.indexerDbName, txid, 'live');
    S.liveGhostSnaps   = await S.liveNode.hubPriceSnapshots({ rounds: S.ghost.rounds });
    S.liveGhostActions = await S.liveNode.priceActions({ rounds: S.ghost.rounds });

    if (S.signerSet) { S.signerSet.stop(); S.signerSet = null; }
    await S.venue.down();
    S.venue = null;
    S.pinned.restore();
    S.pinned = null;
    return true;
}

async function replayFromChain(S) {
    let up = false;
    // --- 7. the replay node, built from nothing, reads the same chain -----
    S.replayNode = new OracleBatchReplayNode({
        label: 'replay', hubDb: S.hubDb, basePort: 61100, priceGraceS: PRICE_GRACE_S });
    try { up = await S.replayNode.up(); }
    catch (err) { await bail(S, 'replay node failed to build: ' + (err && err.message)); return false; }
    if (!up) { await bail(S, S.replayNode.unavailable); return false; }

    console.log('  AT9: replay node built; replaying the chain to block ' + S.targetHeight + '...');
    await S.replayNode.waitForHeight(S.targetHeight);
    await chain.waitForPushDelivery(S.replayNode, 'replay');

    for (const txid of S.allTx) S.replayRows[txid] = await chain.waitForPriceRow(S.conn, S.replayNode.indexerDbName, txid, 'replay');
    S.replayGhostSnaps  = await S.replayNode.hubPriceSnapshots({ rounds: S.ghost.rounds });
    S.replayGhostMirror = await S.replayNode.mirrorPriceSnapshots({ rounds: S.ghost.rounds });
    return true;
}

const STEPS = [
    startLiveNode,
    publishWindow,
    deriveWindowFacts,
    measureEmitSmaller,
    craftHostileWires,
    landWires,
    absorbOnLive,
    replayFromChain,
];

module.exports = { STEPS, teardown };
