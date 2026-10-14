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

const assert = require('assert');

const { OracleBatchVenue } = require('../../../helpers/oracleBatchVenue');
const drive = require('../../../helpers/oracleBatchDrive');
const { startDisposableHubDb } = require('../../../helpers/disposableHubDb');
const { WINDOW_ROUNDS, VALIDATORS, GRACE_MS } = require('./constants');
const { parseBatchWire, encodeBatchWire, tamperPriceDigit, tamperHeaderAnchor } = require('./wire');
const { waitMined } = require('./chain');
const s = require('./state');

// Best-effort teardown of everything a stage may have started. Idempotent: it is
// the bail path of every stage and the after() hook.
async function teardown() {
    if (s.signerSet)  { try { s.signerSet.stop(); } catch (internal) { /* teardown is best effort */ } }
    if (s.venue)      await s.venue.down();
    if (s.replayNode) await s.replayNode.down();
    if (s.liveConn)   { try { await s.liveConn.end(); } catch (internal) { /* ditto */ } }
    if (s.hubDb)      await s.hubDb.stop();
    if (s.pinned)     s.pinned.restore();
}

async function bail(why) {
    console.log('AT4 unavailable: ' + why);
    await teardown();
    s.signerSet = s.venue = s.replayNode = s.liveConn = s.hubDb = s.pinned = null;
}

// Keep the publisher's batch BUFFER out of the checkout, and out of THIS run.
// OraclePublisher derives bufferPath from queuePath in its CONSTRUCTOR, and the
// venue redirects queuePath afterwards, so the redirect never reaches the
// buffer: left alone the rail writes `<cwd>/data/publisher-queue.buffer.jsonl`
// into the working tree and RELOADS it next run, so a previous drill's rounds
// arrive in this one and fail their signing round.
function redirectPublisherBuffers() {
    for (const pub of s.venue.publishers) {
        if (pub.queuePath) pub.bufferPath = String(pub.queuePath).replace(/\.jsonl$/, '') + '.buffer.jsonl';
        if (pub['_buffer'] && typeof pub['_buffer'].clear === 'function') pub['_buffer'].clear();
    }
}

// Returns true once the federation is up and the shared database is held.
async function startFederation() {
    // Started once, here, and shared with the venue and the replay node. The
    // venue's own startDisposableHubDb resolves this same handle and hands back a
    // no-op stop(), so tearing the federation down cannot take the replay node's
    // database server with it.
    s.hubDb = await startDisposableHubDb();
    if (!s.hubDb) { console.log('AT4 unavailable: no env hub DB and Docker unavailable'); return false; }

    // MUST precede venue.up(): OraclePublisher reads both knobs in its constructor.
    s.pinned = drive.pinBatchWindow({ windowRounds: WINDOW_ROUNDS, graceMs: GRACE_MS });

    s.venue = new OracleBatchVenue({
        coin: 'dogecoin', network: 'regtest',
        validatorCount: VALIDATORS,
        basePort: 33900,
        roundBase: drive.alignedRoundBase(WINDOW_ROUNDS),
        expectWireVersion: 0
    });

    let up = false;
    try { up = await s.venue.up(); }
    catch (err) { await bail('venue failed to build: ' + (err && err.message)); return false; }
    if (!up) { await bail(s.venue.unavailable); return false; }

    redirectPublisherBuffers();

    // Every hub, not just the leader: OraclePublisher builds a signer lazily and
    // only the elected leader reaches that call, so without this no follower has
    // registered the XPRICEB handler and the signing round expires at 1/N.
    s.signerSet = drive.attachBatchSigners(s.venue);
    return true;
}

// One genuinely signed batch on a real chain.
async function publishHonestBatch() {
    s.rounds = await drive.finalizeRoundsNoWait(s.venue, WINDOW_ROUNDS);
    const settle = await drive.waitForPublications(s.venue, { min: 1, quietMs: 20_000, timeoutMs: 300_000 });
    if (!settle.reached || s.venue.publications.length === 0) {
        await bail('the federation never published a batch for the window.' +
            drive.railDiagnosis(s.venue, s.signerSet));
        return false;
    }

    s.honest = s.venue.publications[0];
    s.parsed = parseBatchWire(s.honest.wire);
    if (!s.parsed.ok) {
        await bail('the published wire does not parse as a PRICE batch: ' + s.parsed.reason);
        return false;
    }

    const honestBlock = await waitMined(s.venue, s.honest.txid);
    s.landed.honest = {
        wire: s.honest.wire, txid: s.honest.txid, bytes: s.honest.wireBytes,
        height: Number(honestBlock.height), tamper: null
    };
    return true;
}

// The two post-signing tampers, on the same rail. Same encoder, same publisher
// address, same node, same blocks. The ONLY thing that is not the federation's
// own is the bytes.
async function landTampers() {
    const digit  = tamperPriceDigit(s.parsed.body);
    const anchor = tamperHeaderAnchor(s.parsed.body);

    for (const [name, t] of [['priceDigit', digit], ['headerAnchor', anchor]]) {
        const wire = encodeBatchWire(t.body, s.parsed.compressed);
        assert.ok(Buffer.byteLength(wire, 'utf8') <= drive.priceBatch.PRICE_WIRE_MAX_BYTES,
            'AT4: the ' + name + ' tamper produced a ' + Buffer.byteLength(wire, 'utf8') +
            ' byte wire, over the ' + drive.priceBatch.PRICE_WIRE_MAX_BYTES + ' byte ceiling; ' +
            'it would be dropped by the encoder rather than judged by a parser');
        assert.notStrictEqual(wire, s.honest.wire, 'AT4: the ' + name + ' tamper changed nothing on the wire');
        const sent  = await drive.broadcastWire(s.venue, wire);
        const block = await waitMined(s.venue, sent.txid);
        s.landed[name] = {
            wire: wire, txid: sent.txid, bytes: sent.wireBytes,
            height: Number(block.height), tamper: t
        };
    }

    const heights = Object.keys(s.landed).map((k) => s.landed[k].height);
    s.minBlock     = Math.min(...heights);
    s.targetHeight = Math.max(...heights);
}

// What the LIVE node made of all three.
async function readLiveVerdicts() {
    for (const name of Object.keys(s.landed)) {
        const row = await s.venue.readIndexedPrice(s.landed[name].txid);
        s.liveStatus[name] = String(row.status);
        s.landed[name].liveRow = {
            version: Number(row.version), round_number: Number(row.round_number),
            batch_first_round: row.batch_first_round, batch_last_round: row.batch_last_round,
            round_count: row.round_count
        };
    }
}

// The federation goes away.
async function stopFederation() {
    s.signerSet.stop(); s.signerSet = null;
    await s.venue.down(); s.venue = null;
    s.pinned.restore(); s.pinned = null;
}

module.exports = {
    bail, teardown, startFederation, publishHonestBatch, landTampers, readLiveVerdicts, stopFederation
};
