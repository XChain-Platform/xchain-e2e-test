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
 * AT1 (cadence): six finalized rounds produce exactly ONE PRICE v0 transaction
 * on DOGE regtest covering all six. There is no longer a per-round wire for a
 * second transaction to be, so "exactly one" is the whole assertion.
 *
 * This is the claim the whole spec rests its cost argument on. Under the v0 rail
 * six finalized rounds are six transactions and six DOGE fees; under v2 they are
 * one. Nothing in this repo had ever demonstrated the second half, because
 * nothing had ever driven a WINDOW: `oracleBatchVenue.finalizeRound` carries one
 * round to one landed transaction, which is exactly the shape v2 abolishes.
 *
 * WHAT IS REAL. Six real PBFT price rounds on four in-process validators with a
 * real peer mesh; a real OracleBatchSigner round in which three peers
 * INDEPENDENTLY rebuild the proposed canonical from their own price_snapshots
 * before signing; the real OraclePublisher window scheduler, packer and wire
 * builder; a real encoder build, signature and broadcast on DOGE regtest; a real
 * block; and the `prices` row read back out of the landing chain's own indexer.
 *
 * THE WINDOW IS PINNED, NOT MOCKED. `ORACLE_BATCH_WINDOW_ROUNDS` stays at its
 * shipped six here, because six is the number AT1 names. What IS shortened is the
 * five-minute grace, to seconds: the grace exists so real stragglers on a real
 * hour boundary can arrive, and six rounds driven back to back in-process have no
 * stragglers to wait for. The round base is aligned to a window boundary so the
 * six rounds fall in one window; an unaligned base would split them across two
 * and produce two wires for a reason that has nothing to do with the code.
 *
 * THE VERDICT IS NOW ASSERTED, not waited on. Capability staking is BTC-only, so
 * on DOGE the indexer resolves the price-capable set from the hub-mirrored
 * `capability_snapshots` at the batch's signed BTC anchor. In production the hub
 * writes those rows itself when a round finalizes; this venue's hubs are
 * in-process on disposable databases the landing chain's indexer never reads, so
 * the venue writes its own validator set there as SETUP and takes it back at
 * teardown (oracleBatchVenue._seedLandingChainPriceCapability states in full what
 * it substitutes for and what would retire it).
 *
 * That is a precondition, not a thumb on the scale. The indexer still parses the
 * wire, still verifies every signature against the batch canonical, and still
 * applies the full source-deduped two-thirds stake test; the assertion below
 * demands `valid` and nothing else. Nothing here is stubbed to manufacture a pass.
 ********************************************************************/

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { OracleBatchVenue } = require('../helpers/oracleBatchVenue');
const drive = require('../helpers/oracleBatchDrive');

// AT1's own numbers. Six rounds is the acceptance test's wording; four validators
// is the venue default and gives a weighted quorum of three, so a signing round
// that reaches quorum has genuinely persuaded peers rather than counted itself.
const WINDOW_ROUNDS = 6;
const VALIDATORS    = 4;
const MIN_SIGNATURES = 3;

// Seconds, not the shipped five minutes. See the header.
const GRACE_MS = 4000;

// The verdict a well-formed PRICE records when the landing chain resolves no
// price-capable validator set at the batch's anchor. Named so the failure message
// can tell that apart from a parse or wire regression.
const CAPABILITY_GAP_STATUS = 'invalid: insufficient signer stake';

describe('AT1 oracle batch cadence: six finalized rounds, ONE PRICE v0 on DOGE regtest (L3)', function () {
    // Six PBFT rounds, a peer signing round, an encoder build, a broadcast and a
    // confirmation on a real chain. The budget is per-suite; every wait inside is a
    // poll that returns the moment its condition holds.
    this.timeout(45 * 60 * 1000);

    let venue = null, pinned = null, signerSet = null;
    let rounds = [], parsed = null, indexed = null, block = null, settle = null;

    before(async function () {
        pinned = drive.pinBatchWindow({ windowRounds: WINDOW_ROUNDS, graceMs: GRACE_MS });
        venue = new OracleBatchVenue({
            coin: 'dogecoin', network: 'regtest',
            validatorCount: VALIDATORS,
            basePort: 33900,
            roundBase: drive.alignedRoundBase(WINDOW_ROUNDS),
            expectWireVersion: 0
        });

        let up = false;
        try { up = await venue.up(); }
        catch (err) {
            console.log('AT1 venue unavailable: ' + (err && err.message));
            await venue.down(); venue = null; pinned.restore();
            this.skip(); return;
        }
        if (!up) {
            console.log('AT1 venue unavailable: ' + venue.unavailable);
            await venue.down(); venue = null; pinned.restore();
            this.skip(); return;
        }

        // Every hub, not just the leader. Without this no follower has registered the
        // XPRICEB handler and the signing round expires at 1/3 sigs.
        signerSet = drive.attachBatchSigners(venue);

        rounds = await drive.finalizeRoundsNoWait(venue, WINDOW_ROUNDS);
        settle = await drive.waitForPublications(venue, { min: 1, quietMs: 25_000, timeoutMs: 300_000 });

        if (venue.publications.length > 0) {
            parsed  = drive.parsePriceBatchWire(venue.publications[0].wire);
            indexed = await venue.readIndexedPrice(venue.publications[0].txid);
            block   = await venue.blockOf(venue.publications[0].txid);
        }

        console.log('\n  --- AT1: what actually landed ---');
        console.log('  rounds driven: ' + rounds.map((r) => r.round).join(', '));
        console.log('  publications:  ' + venue.publications.length);
        for (const p of venue.publications) {
            console.log('    leader hub ' + p.hubIndex + '  v' + p.wireVersion + '  wire ' + p.wireBytes +
                'B  ' + p.encoding + '  tx ' + p.txid);
        }
        if (parsed && parsed.ok) {
            console.log('  wire: rounds [' + parsed.firstRound + '..' + parsed.lastRound + '] count ' +
                parsed.roundCount + '  sigs ' + parsed.sigs.length + '  anchor ' + parsed.anchor +
                '  body ' + parsed.bodyBytes + 'B  compressed=' + parsed.compressed +
                (parsed.compressed ? ('  (' + parsed.compressedBytes + 'B, ratio ' +
                    parsed.ratio.toFixed(2) + ':1)') : ''));
        }
        if (indexed) {
            console.log('  indexed: action ' + indexed.action_index + '  version ' + indexed.version +
                '  round ' + indexed.round_number + '  batch [' + indexed.batch_first_round + '..' +
                indexed.batch_last_round + '] count ' + indexed.round_count +
                '  block ' + (block ? block.height : '?') + '  -> ' + indexed.status);
        }
        console.log(drive.railDiagnosis(venue, signerSet));
        console.log('  ---------------------------------\n');
    });

    after(async function () {
        if (signerSet) signerSet.stop();
        if (venue) await venue.down();
        if (pinned) pinned.restore();
    });

    it('all six rounds finalized on a real multi-signature quorum', function () {
        assert.strictEqual(rounds.length, WINDOW_ROUNDS,
            'expected ' + WINDOW_ROUNDS + ' finalized rounds, got ' + rounds.length);
        for (const r of rounds) {
            const distinct = new Set(r.signatures.map((s) => String(s.pubkey).toLowerCase()));
            assert.ok(distinct.size >= MIN_SIGNATURES,
                'CONSENSUS rung: round ' + r.round + ' finalized on only ' + distinct.size +
                ' distinct signer(s); a weighted quorum over ' + VALIDATORS + ' equal sources needs ' +
                MIN_SIGNATURES + '. Nothing downstream of this can be read.' +
                drive.railDiagnosis(venue, signerSet));
        }
    });

    it('the window produced EXACTLY ONE transaction, and it stayed one', function () {
        assert.ok(settle.reached,
            'no wire was ever broadcast for the window. Read the rail state: signRounds 0 means the ' +
            'leader never proposed (leader election or the window self-check); signTimeouts > 0 means ' +
            'it proposed and no quorum answered (SIGNING ROUND rung); unpublishable > 0 means quorum ' +
            'was reached and the wire did not fit (WIRE CEILING rung).' + drive.railDiagnosis(venue, signerSet));
        assert.strictEqual(venue.publications.length, 1,
            'AT1 requires exactly ONE transaction for ' + WINDOW_ROUNDS + ' finalized rounds; the ' +
            'federation emitted ' + venue.publications.length + '. More than one means the window ' +
            'split or the rounds fell in different windows.' + drive.railDiagnosis(venue, signerSet));
        assert.ok(settle.settled,
            'a second wire was still arriving when the quiet window expired, so "exactly one" is a ' +
            'race this run happened to win rather than a property.' + drive.railDiagnosis(venue, signerSet));
    });

    // The old companion assertion here required ZERO per-round wires alongside the batch.
    // It is void and was self-contradicting: the per-round wire is DELETED, the batch IS
    // version 0, so a loop demanding every publication be something other than version 0
    // could never hold beside the assertion directly above it. With no second wire for a
    // round to ride, "exactly one publication" (asserted above) is the whole cadence claim.
    it('the one transaction is a PRICE batch on the wire', function () {
        const p = venue.publications[0];
        assert.strictEqual(p.wireVersion, 0,
            'the federation published PRICE v' + p.wireVersion + ', not the batch version 0');
        assert.ok(/^[0-9a-f]{64}$/.test(String(p.txid)),
            'PUSH rung: the publish returned ' + p.txid + ' rather than a transaction id');
    });

    it('the single wire covers all six rounds, with each round\'s own full pair data', function () {
        assert.ok(parsed.ok, 'the landed wire does not parse as PRICE v0: ' + parsed.reason);
        const driven = rounds.map((r) => r.round);
        const onWire = parsed.rounds.map((r) => r.round);
        assert.deepStrictEqual(onWire, driven,
            'the batch covers rounds [' + onWire.join(', ') + '] but the federation finalized [' +
            driven.join(', ') + ']. AT1 is the claim that ONE wire carries ALL of them.');
        assert.strictEqual(parsed.roundCount, WINDOW_ROUNDS);
        assert.strictEqual(parsed.firstRound, driven[0]);
        assert.strictEqual(parsed.lastRound, driven[driven.length - 1]);
        // Full bodies, not a digest and not a sample: the amended ruling's whole point.
        for (let i = 0; i < parsed.rounds.length; i++) {
            const wireRound = parsed.rounds[i];
            // Compared by NAME and by NUMERIC VALUE, not by string. The aggregate the
            // federation finalizes is fixed to eight decimals by OracleConsensus
            // (`61000` submitted comes back as `61000.00000000`), and that normalization
            // is the producer's business; what AT1 claims is that the wire carries the
            // price the round finalized, which is a value, not a spelling.
            const expected = rounds[i].prices
                .map((p) => ({ pair: p.coinPair, price: Number(p.price) }))
                .sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
            const onWirePairs = wireRound.pairs.map((p) => ({ pair: p.pair, price: Number(p.price) }));
            assert.deepStrictEqual(onWirePairs, expected,
                'round ' + wireRound.round + ' on the wire carries different pair data than the ' +
                'federation finalized; a batch that is not the full bodies breaks chain replay');
            assert.strictEqual(wireRound.timestamp, rounds[i].anchorTime);
        }
        // Section 4: the batch header anchor IS the last included round's own anchor.
        assert.strictEqual(parsed.anchor, parsed.rounds[parsed.rounds.length - 1].btcBlockHeight,
            'the batch header anchor is not the last round\'s anchor; both verifiers reject that wire');
    });

    it('the batch carries a real quorum signature set over the batch canonical', function () {
        const distinct = new Set(parsed.sigs.map((s) => s.pubkey));
        assert.strictEqual(distinct.size, parsed.sigs.length, 'the wire carries a duplicate signer');
        assert.ok(distinct.size >= MIN_SIGNATURES,
            'SIGNING ROUND rung: the batch carries only ' + distinct.size + ' signature(s); a weighted ' +
            'quorum over ' + VALIDATORS + ' equal sources needs ' + MIN_SIGNATURES + '. A short set means ' +
            'peers could not reproduce the proposed canonical from their own price_snapshots.' +
            drive.railDiagnosis(venue, signerSet));
        // Independently verified against the bytes the leader's signing round actually
        // built, so this asserts the wire's signatures cover the wire's content.
        const proposal = signerSet.proposals.find((p) => p.met === true);
        assert.ok(proposal && proposal.canonical,
            'no signing round on any hub reached quorum' + drive.railDiagnosis(venue, signerSet));
        const ValidatorIdentity = require('../helpers/oracleBatchVenue').ValidatorIdentity;
        let verified = 0;
        for (const s of parsed.sigs) if (ValidatorIdentity.verify(proposal.canonical, s.sig, s.pubkey)) verified++;
        assert.strictEqual(verified, parsed.sigs.length,
            'only ' + verified + ' of ' + parsed.sigs.length + ' signatures on the wire verify against ' +
            'the canonical the signing round produced');
    });

    it('the wire was mined and the landing chain stored the batch it carried', function () {
        assert.ok(block && Number.isFinite(Number(block.height)),
            'PUSH rung: transaction ' + venue.publications[0].txid + ' is not in a block on the ' +
            venue.rail.code + ' node');
        assert.strictEqual(Number(indexed.version), 0,
            'PARSE rung: the indexer recorded PRICE version ' + indexed.version + ' for a batch wire');
        assert.strictEqual(Number(indexed.batch_first_round), parsed.firstRound,
            'PARSE rung: the indexer stored batch_first_round ' + indexed.batch_first_round +
            ' for a wire whose FIRST_ROUND is ' + parsed.firstRound);
        assert.strictEqual(Number(indexed.batch_last_round), parsed.lastRound);
        assert.strictEqual(Number(indexed.round_count), WINDOW_ROUNDS,
            'PARSE rung: the indexer stored round_count ' + indexed.round_count + ' for a ' +
            WINDOW_ROUNDS + '-round batch');
        assert.strictEqual(Number(indexed.round_number), parsed.firstRound,
            'D21: a v2 row carries FIRST_ROUND in round_number');
        const storedRounds = JSON.parse(indexed.rounds_json || '[]');
        assert.strictEqual(storedRounds.length, WINDOW_ROUNDS,
            'PARSE rung: rounds_json holds ' + storedRounds.length + ' round(s), not ' + WINDOW_ROUNDS);
    });

    it('the landing chain accepted the batch', function () {
        const status = String(indexed.status);
        assert.strictEqual(status, 'valid',
            'SIGNER RESOLUTION rung: the batch indexed as "' + status + '". "' +
            CAPABILITY_GAP_STATUS + '" means the landing chain resolved an EMPTY price-capable set at ' +
            'the batch anchor: check that the venue seeded its `price` capability_snapshots rows at ' +
            'anchor ' + parsed.anchor + ' and that a previous run\'s teardown did not remove them ' +
            'mid-flight. Any other status is a parse, fee or wire regression.' +
            drive.railDiagnosis(venue, signerSet));
    });
});
