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
 * L3 integration: the oracle publish rail, end to end, on today's PRICE v0.
 *
 * This is the venue smoke test for `test/helpers/oracleBatchVenue.js`. It drives
 * the whole rail with nothing stubbed between the federation and the chain:
 *
 *   real PBFT price round on N in-process validators
 *     -> real OraclePublisher leader rotation
 *     -> real PRICE wire
 *     -> real encoder build + signature + node broadcast on DOGE regtest
 *     -> real block
 *     -> real decoder + indexer parse
 *     -> the `prices` row read back off the landing chain's own database
 *
 * WHY v0 WHEN THE POINT IS v2. PRICE v2 does not exist yet. Proving the rig on
 * the version that DOES exist is what makes the v2 drills a small addition
 * (finalize a window, assert one wire covers six rounds) rather than a second
 * venue build. Nothing here matches on `PRICE|0|`: the venue reports the version
 * it observed on the wire and this suite asserts against that, so the same rig
 * carries a v2 publisher unchanged.
 *
 * WHAT THE LANDED VERDICT CAN AND CANNOT BE, measured 2026-08-26. The indexer
 * resolves the `price` capability set from its own `stakes` table on every
 * chain, capability staking is BTC-only (`CAPABILITIES: {}` in
 * xchain-indexer/src/coins/DOGE.js), and the hub-mirrored capability_snapshots
 * fallback covers only `cross_chain` and `oracle_publish`. So a PRICE landing on
 * DOGE qualifies zero signers and records `invalid: insufficient signer stake`
 * no matter how good the federation's quorum was. That is a property of the
 * indexer, not of this venue, so the verdict assertion below accepts either that
 * exact string or a clean `valid`, and fails on anything else: a parse error, an
 * unknown version, a fee rejection are all real regressions this suite must
 * catch.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { OracleBatchVenue, ValidatorIdentity } = require('../helpers/oracleBatchVenue');

// Three rounds over four validators: enough that the publisher's
// `round % publisherCount` rotation must elect three DIFFERENT leaders, which is
// the property that distinguishes a working rail from one hub doing all the work.
const VALIDATORS = 4;
const ROUNDS     = 3;

// PBFT quorum for N=4 under the seeded weight snapshot: every source carries
// equal weight, so 3*tally > 2*S needs three of the four.
const MIN_SIGNATURES = 3;

// OraclePublisher's own pre-enqueue ceiling, and the encoder's data-payload
// limit it mirrors. A wire above this is dropped before it is ever queued.
const PRICE_WIRE_MAX_BYTES = 8189;

// The one verdict the landing chain can legitimately give a well-formed PRICE
// today, besides accepting it. See the header.
const KNOWN_CAPABILITY_GAP_STATUS = 'invalid: insufficient signer stake';

// Split a PRICE v0 wire back into its fields, so the assertion is "the indexer
// stored what the publisher put on the wire" rather than "the indexer stored
// what the test expected". Only reached when the observed wire version is 0.
function parsePriceV0Wire(wire) {
    const p = wire.split('|');
    const pairCount = parseInt(p[5], 10);
    let idx = 6;
    const pairs = [];
    for (let i = 0; i < pairCount; i++) pairs.push({ pair: p[idx++], price: p[idx++] });
    const sigCount = parseInt(p[idx++], 10);
    const sigs = [];
    for (let i = 0; i < sigCount; i++) sigs.push({ pubkey: p[idx++].toLowerCase(), sig: p[idx++].toLowerCase() });
    return {
        version:        parseInt(p[1], 10),
        round:          parseInt(p[2], 10),
        timestamp:      parseInt(p[3], 10),
        btcBlockHeight: parseInt(p[4], 10),
        pairs:          pairs,
        sigs:           sigs
    };
}

describe('Oracle publish venue: quorum federation on the live DOGE regtest publish rail (L3)', function () {
    // Every round is a full PBFT round plus an encoder build, a signature, a
    // broadcast and a confirmation on a real chain, so the budget is per-suite
    // rather than per-round; the venue's own waits are polls that return early.
    this.timeout(30 * 60 * 1000);

    let venue = null;
    let rounds = [];
    let indexed = [];   // [{ publication, row, block }]

    before(async function () {
        venue = new OracleBatchVenue({
            coin:            'dogecoin',
            network:         'regtest',
            validatorCount:  VALIDATORS,
            basePort:        33800,
            expectWireVersion: 0
        });
        let up = false;
        try {
            up = await venue.up();
        } catch (err) {
            // A venue that cannot be built is a skip, not a red test, but the
            // reason has to be printed or the skip is indistinguishable from a
            // pass that proved nothing.
            console.log('Oracle publish venue unavailable: ' + (err && err.message));
            await venue.down();
            venue = null;
            this.skip();
            return;
        }
        if (!up) {
            console.log('Oracle publish venue unavailable: ' + venue.unavailable);
            await venue.down();
            venue = null;
            this.skip();
            return;
        }

        rounds = await venue.finalizeRounds(ROUNDS);

        for (const pub of venue.publications) {
            const row   = await venue.readIndexedPrice(pub.txid);
            const block = await venue.blockOf(pub.txid);
            indexed.push({ publication: pub, row: row, block: block });
        }

        // The run's evidence, printed once: this is a live-venue suite, and a
        // green tick with no txids proves nothing to an operator reading CI.
        console.log('\n  --- oracle publish venue: what actually landed ---');
        for (const r of rounds) {
            const p = r.publication;
            console.log('  round ' + r.round + '  leader hub ' + p.hubIndex + '  v' + p.wireVersion +
                '  ' + p.wireBytes + 'B  ' + p.encoding + '  quorum ' + r.signatures.length + '/' +
                VALIDATORS + '  validator_count ' + r.validatorCount + '  tx ' + p.txid);
        }
        for (const i of indexed) {
            console.log('  tx ' + i.publication.txid.slice(0, 16) + '...  block ' +
                (i.block ? i.block.height : '?') + '  action ' + i.row.action_index +
                '  round ' + i.row.round_number + '  sigs ' + i.row.sig_count +
                '  -> ' + i.row.status);
        }
        console.log('  -------------------------------------------------\n');
    });

    after(async function () {
        if (venue) await venue.down();
    });

    it('every round finalizes on a real multi-signature quorum across the whole federation', function () {
        assert.strictEqual(rounds.length, ROUNDS, 'expected ' + ROUNDS + ' finalized rounds');
        for (const r of rounds) {
            const pubkeys = new Set(r.signatures.map((s) => String(s.pubkey).toLowerCase()));
            assert.ok(pubkeys.size >= MIN_SIGNATURES,
                'round ' + r.round + ' finalized on only ' + pubkeys.size + ' distinct signer(s); ' +
                'a weighted quorum over ' + VALIDATORS + ' equal sources needs ' + MIN_SIGNATURES);
            assert.ok(r.validatorCount >= MIN_SIGNATURES,
                'round ' + r.round + ' persisted validator_count ' + r.validatorCount +
                ', below the quorum it claims to have finalized on');
            // Deliberately NOT asserted: r.commitSet (price_snapshots.consensus_proof).
            // Under a weighted quorum the round finalizes on the SIGNATURE tally, so a
            // hub can store the round with only its own address in the commit set while
            // holding all four signatures. The signature set above is the one that
            // reaches the chain and the one an indexer re-verifies.
        }
    });

    it('the signatures on the wire verify against the canonical every hub signed', function () {
        for (const r of rounds) {
            if (r.publication.wireVersion !== 0) this.skip();
            const parsed = parsePriceV0Wire(r.publication.wire);
            // The canonical is built from the wire's OWN fields by the hub's own
            // producer, so this asserts that the signatures on the wire cover the
            // body on the wire. A wire whose signatures do not is the failure an
            // indexer later reports as a quorum miss with no explanation.
            const payload = venue.priceCanonical(
                parsed.round, parsed.timestamp, parsed.pairs, parsed.btcBlockHeight);
            let verified = 0;
            for (const s of parsed.sigs) {
                if (ValidatorIdentity.verify(payload, s.sig, s.pubkey)) verified++;
            }
            assert.ok(verified >= MIN_SIGNATURES,
                'round ' + r.round + ': only ' + verified + '/' + parsed.sigs.length +
                ' wire signatures verify against the round canonical');
            assert.strictEqual(parsed.sigs.length, r.signatures.length,
                'round ' + r.round + ': the publisher put ' + parsed.sigs.length + ' signature(s) on ' +
                'the wire but the federation finalized on ' + r.signatures.length);
        }
    });

    it('each finalized round produced exactly one publish, inside the wire ceiling', function () {
        assert.strictEqual(venue.publications.length, ROUNDS,
            'expected one publish per finalized round, got ' + venue.publications.length);
        const versions = new Set();
        for (const p of venue.publications) {
            assert.ok(p.wireVersion !== null, 'a publish carried something that is not a PRICE wire');
            versions.add(p.wireVersion);
            assert.ok(p.wireBytes <= PRICE_WIRE_MAX_BYTES,
                'wire for hub ' + p.hubIndex + ' is ' + p.wireBytes + ' bytes, over the ' +
                PRICE_WIRE_MAX_BYTES + ' ceiling; OraclePublisher would have dead-lettered it');
            assert.ok(/^[0-9a-f]{64}$/.test(String(p.txid)),
                'publish did not return a real transaction id: ' + p.txid);
        }
        assert.strictEqual(versions.size, 1, 'the run mixed PRICE wire versions: ' + [...versions].join(', '));
    });

    it('leader rotation spread the publishes across distinct validators', function () {
        const leaders = new Set(venue.publications.map((p) => p.hubIndex));
        assert.strictEqual(leaders.size, ROUNDS,
            'expected ' + ROUNDS + ' distinct publishing validators over ' + ROUNDS +
            ' consecutive rounds, saw hub(s) ' + [...leaders].join(', ') +
            '; a single publisher doing every round means the rotation is not being read');
    });

    it('every publish was mined into a real block on the landing chain', function () {
        for (const i of indexed) {
            assert.ok(i.block && Number.isFinite(Number(i.block.height)),
                'transaction ' + i.publication.txid + ' is not in a block on the ' +
                venue.rail.code + ' node');
        }
    });

    it('the landing chain decoded and indexed each wire byte-for-byte', function () {
        for (const i of indexed) {
            const p = i.publication;
            if (p.wireVersion !== 0) this.skip();
            const parsed = parsePriceV0Wire(p.wire);
            assert.strictEqual(Number(i.row.version), parsed.version,
                'indexer recorded a different PRICE version than the publisher emitted');
            assert.strictEqual(Number(i.row.round_number), parsed.round);
            assert.strictEqual(Number(i.row.round_timestamp), parsed.timestamp);
            assert.strictEqual(Number(i.row.pair_count), parsed.pairs.length);
            assert.strictEqual(Number(i.row.sig_count), parsed.sigs.length);
            assert.deepStrictEqual(JSON.parse(i.row.pairs_json), parsed.pairs,
                'the pairs the indexer stored are not the pairs on the wire');
            assert.deepStrictEqual(JSON.parse(i.row.sigs_json), parsed.sigs,
                'the signatures the indexer stored are not the signatures on the wire');
        }
    });

    it('the landing chain reached a verdict that is either an accept or the known capability gap', function () {
        for (const i of indexed) {
            const status = String(i.row.status);
            const ok = status === 'valid' || status === KNOWN_CAPABILITY_GAP_STATUS;
            assert.ok(ok,
                'tx ' + i.publication.txid + ' indexed as "' + status + '". Only two verdicts are ' +
                'expected here: "valid", or "' + KNOWN_CAPABILITY_GAP_STATUS + '" (the ' +
                venue.rail.code + ' indexer has no price-capability set at all, because capability ' +
                'staking is BTC-only and the hub-mirrored capability_snapshots fallback covers only ' +
                'cross_chain and oracle_publish). Anything else is a parse, fee or wire regression.');
            if (status !== 'valid') {
                console.log('  NOTE: round ' + i.row.round_number + ' landed but did not validate: ' +
                    status + '. PRICE cannot validate on a non-BTC indexer today; see the suite header.');
            }
        }
    });
});
