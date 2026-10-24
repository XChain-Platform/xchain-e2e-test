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
 * L3 integration: one complete oracle batch window, end to end.
 ********************************************************************/

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { OracleBatchVenue, ValidatorIdentity } = require('../helpers/oracleBatchVenue');
const drive = require('../helpers/oracleBatchDrive');

const VALIDATORS = 4;
const WINDOW_ROUNDS = 3;
const MIN_SIGNATURES = 3;
const GRACE_MS = 4000;
const PRICE_WIRE_MAX_BYTES = 8189;

let venue = null;
let pinned = null;
let signerSet = null;
let rounds = [];
let parsed = null;
let indexed = null;
let block = null;
let settle = null;
let venueSetup = null;
let venueFailure = null;

async function initializeVenue() {
    pinned = drive.pinBatchWindow({ windowRounds: WINDOW_ROUNDS, graceMs: GRACE_MS });
    venue = new OracleBatchVenue({
        coin: 'dogecoin',
        network: 'regtest',
        validatorCount: VALIDATORS,
        basePort: 33800,
        roundBase: drive.alignedRoundBase(WINDOW_ROUNDS),
        expectWireVersion: 0,
        expectValidationStatus: 'valid'
    });

    let up = false;
    try {
        up = await venue.up();
    } catch (err) {
        console.log('Oracle publish venue unavailable: ' + (err && err.message));
        await venue.down();
        venue = null;
        pinned.restore();
        pinned = null;
        return false;
    }
    if (!up) {
        console.log('Oracle publish venue unavailable: ' + venue.unavailable);
        await venue.down();
        venue = null;
        pinned.restore();
        pinned = null;
        return false;
    }

    venue.anchorTimeBase = venue.anchorTimeFor(0);
    signerSet = drive.attachBatchSigners(venue);
    rounds = await drive.finalizeRoundsNoWait(venue, WINDOW_ROUNDS);
    settle = await drive.waitForPublications(venue, {
        min: 1,
        quietMs: 25_000,
        timeoutMs: 300_000
    });

    if (venue.publications.length > 0) {
        parsed = drive.parsePriceBatchWire(venue.publications[0].wire);
        indexed = await venue.readIndexedPrice(venue.publications[0].txid);
        block = await venue.blockOf(venue.publications[0].txid);
    }

    console.log('\n  --- oracle batch venue: what actually landed ---');
    console.log('  rounds driven: ' + rounds.map((r) => r.round).join(', '));
    console.log('  publications:  ' + venue.publications.length);
    for (const p of venue.publications) {
        console.log('    leader hub ' + p.hubIndex + '  v' + p.wireVersion + '  ' + p.wireBytes +
            'B  ' + p.encoding + '  tx ' + p.txid);
    }
    if (parsed && parsed.ok) {
        console.log('  wire: rounds [' + parsed.firstRound + '..' + parsed.lastRound + '] count ' +
            parsed.roundCount + '  sigs ' + parsed.sigs.length + '  anchor ' + parsed.anchor);
    }
    if (indexed) {
        console.log('  indexed: action ' + indexed.action_index + '  batch [' +
            indexed.batch_first_round + '..' + indexed.batch_last_round + '] count ' +
            indexed.round_count + '  block ' + (block ? block.height : '?') + '  -> ' + indexed.status);
    }
    console.log(drive.railDiagnosis(venue, signerSet));
    console.log('  ----------------------------------------------------\n');
    return true;
}

async function setUpVenue() {
    if (venueFailure) this.skip();
    if (!venueSetup) venueSetup = initializeVenue();
    try {
        if (!await venueSetup) this.skip();
    } catch (err) {
        venueFailure = err;
        throw err;
    }
}

async function tearDownVenue() {
    if (signerSet) signerSet.stop();
    if (venue) await venue.down();
    if (pinned) pinned.restore();
}

describe('Oracle publish venue: one batch window on the live DOGE regtest rail (L3)', function () {
    this.timeout(30 * 60 * 1000);
    before(setUpVenue);

    it('finalizes every round on a real multi-signature quorum', function () {
        assert.strictEqual(rounds.length, WINDOW_ROUNDS,
            'expected ' + WINDOW_ROUNDS + ' finalized rounds, got ' + rounds.length);
        for (const r of rounds) {
            const pubkeys = new Set(r.signatures.map((s) => String(s.pubkey).toLowerCase()));
            assert.ok(pubkeys.size >= MIN_SIGNATURES,
                'round ' + r.round + ' finalized on only ' + pubkeys.size + ' distinct signer(s)' +
                drive.railDiagnosis(venue, signerSet));
            assert.strictEqual(r.anchorTime, venue.anchorTimeFor(r.round - venue.roundBase),
                'round ' + r.round + ' did not use its nominal hub-clock timestamp');
        }
    });

    it('publishes exactly once after the complete window and stays settled', function () {
        assert.ok(settle.reached,
            'the completed window never reached the broadcast hook' + drive.railDiagnosis(venue, signerSet));
        assert.strictEqual(venue.publications.length, 1,
            WINDOW_ROUNDS + ' rounds produced ' + venue.publications.length + ' publications' +
            drive.railDiagnosis(venue, signerSet));
        assert.ok(settle.settled,
            'the publication count did not remain stable' + drive.railDiagnosis(venue, signerSet));
        const publishedWindows = venue.publisherStats()
            .reduce((sum, stats) => sum + Number(stats.batchWindowsPublished || 0), 0);
        assert.strictEqual(publishedWindows, 1,
            'publisher stats recorded ' + publishedWindows + ' published windows');
    });
});

describe('Oracle publish venue: one batch window on the live DOGE regtest rail (L3)', function () {
    this.timeout(30 * 60 * 1000);
    before(setUpVenue);

    it('puts every driven round and its full price body in the single wire', function () {
        assert.ok(parsed && parsed.ok,
            'the publication does not parse as a PRICE batch: ' + (parsed && parsed.reason));
        const driven = rounds.map((r) => r.round);
        assert.deepStrictEqual(parsed.rounds.map((r) => r.round), driven);
        assert.strictEqual(parsed.firstRound, driven[0]);
        assert.strictEqual(parsed.lastRound, driven[driven.length - 1]);
        assert.strictEqual(parsed.roundCount, WINDOW_ROUNDS);

        for (let i = 0; i < parsed.rounds.length; i++) {
            const expectedPairs = rounds[i].prices
                .map((p) => ({ pair: p.coinPair, price: Number(p.price) }))
                .sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
            const wirePairs = parsed.rounds[i].pairs
                .map((p) => ({ pair: p.pair, price: Number(p.price) }));
            assert.deepStrictEqual(wirePairs, expectedPairs,
                'wire pair data differs for round ' + rounds[i].round);
            assert.strictEqual(parsed.rounds[i].timestamp, rounds[i].anchorTime);
        }
        assert.strictEqual(parsed.anchor, parsed.rounds[parsed.rounds.length - 1].btcBlockHeight);
    });

    it('carries a distinct quorum over the batch canonical', function () {
        const distinct = new Set(parsed.sigs.map((s) => s.pubkey));
        assert.strictEqual(distinct.size, parsed.sigs.length, 'the batch carries a duplicate signer');
        assert.ok(distinct.size >= MIN_SIGNATURES,
            'the batch carries only ' + distinct.size + ' distinct signer(s)' +
            drive.railDiagnosis(venue, signerSet));

        const proposal = signerSet.proposals.find((p) => p.met === true);
        assert.ok(proposal && proposal.canonical,
            'no batch signing round reached quorum' + drive.railDiagnosis(venue, signerSet));
        let verified = 0;
        for (const sig of parsed.sigs) {
            if (ValidatorIdentity.verify(proposal.canonical, sig.sig, sig.pubkey)) verified++;
        }
        assert.strictEqual(verified, parsed.sigs.length,
            'only ' + verified + '/' + parsed.sigs.length + ' batch signatures verified');
    });

    it('keeps the one publish inside the wire ceiling', function () {
        const publication = venue.publications[0];
        assert.strictEqual(publication.wireVersion, 0);
        assert.ok(publication.wireBytes <= PRICE_WIRE_MAX_BYTES,
            'batch wire is ' + publication.wireBytes + ' bytes, over the ' + PRICE_WIRE_MAX_BYTES + ' ceiling');
        assert.ok(/^[0-9a-f]{64}$/.test(String(publication.txid)),
            'publish returned an invalid transaction id: ' + publication.txid);
    });
});

describe('Oracle publish venue: one batch window on the live DOGE regtest rail (L3)', function () {
    this.timeout(30 * 60 * 1000);
    before(setUpVenue);
    after(tearDownVenue);

    it('mines and indexes the full batch from the wire', function () {
        assert.ok(block && Number.isFinite(Number(block.height)),
            'transaction ' + venue.publications[0].txid + ' is not in a block');
        assert.strictEqual(Number(indexed.version), 0);
        assert.strictEqual(Number(indexed.round_number), parsed.firstRound);
        assert.strictEqual(Number(indexed.batch_first_round), parsed.firstRound);
        assert.strictEqual(Number(indexed.batch_last_round), parsed.lastRound);
        assert.strictEqual(Number(indexed.round_count), WINDOW_ROUNDS);
        const storedRounds = JSON.parse(indexed.rounds_json || '[]').map((r) => ({
            round: r.round,
            timestamp: r.timestamp,
            btcBlockHeight: r.btc_block_height,
            pairs: r.pairs
        }));
        assert.deepStrictEqual(storedRounds, parsed.rounds);
        assert.deepStrictEqual(JSON.parse(indexed.sigs_json || '[]'), parsed.sigs);
    });

    it('accepts the quorum-signed batch', function () {
        assert.strictEqual(String(indexed.status), 'valid',
            'landing chain indexed the batch as "' + indexed.status + '"' +
            drive.railDiagnosis(venue, signerSet));
    });
});
