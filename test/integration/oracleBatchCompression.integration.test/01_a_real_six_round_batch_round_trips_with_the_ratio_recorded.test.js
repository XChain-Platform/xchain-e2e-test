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
const { priceBatch, WINDOW_ROUNDS, MIN_SIGNATURES, BATCH_WIRE_VERSION } = require('./helpers/constants');

module.exports = function register(S) {
    // -----------------------------------------------------------------------
    // Clause 1: a REAL six-round batch round-trips, with the ratio recorded
    // -----------------------------------------------------------------------

    it('the federation finalized six real rounds and published them as ONE compressed batch', function () {
        assert.strictEqual(S.rounds.length, WINDOW_ROUNDS,
            'expected ' + WINDOW_ROUNDS + ' finalized rounds, got ' + S.rounds.length + S.railState);
        for (const r of S.rounds) {
            const distinct = new Set(r.signatures.map((s) => String(s.pubkey).toLowerCase()));
            assert.ok(distinct.size >= MIN_SIGNATURES,
                'CONSENSUS rung: round ' + r.round + ' finalized on only ' + distinct.size +
                ' distinct signer(s); nothing downstream of this can be read.' + S.railState);
        }
        assert.strictEqual(S.parsedBody.roundCount, WINDOW_ROUNDS,
            'AT9 requires a REAL six-round batch; the wire carries ' + S.parsedBody.roundCount + ' round(s)');
        assert.deepStrictEqual(S.parsedBody.rounds.map((r) => r.round), S.rounds.map((r) => r.round),
            'the batch covers rounds the federation did not finalize, so this is not a real batch');
        assert.ok(S.parsedWire.compressed,
            'AT9 clause 1 needs a COMPRESSED wire to round-trip and the publisher emitted the ' +
            'uncompressed form. At ' + S.parsedWire.bodyBytes + ' bytes of body over ' +
            S.parsedBody.rounds.length + ' rounds the packed form should have won; read the ' +
            'emit-smaller measurement in the run evidence above.');
    });

    it('body -> deflate -> base64 -> parse returns the IDENTICAL body, and the ratio is recorded', function () {
        // The wire the publisher emitted is itself strictly canonical base64.
        assert.notStrictEqual(priceBatch.decodeCanonicalBase64(S.parsedWire.field), null,
            'the publisher emitted a base64 field the consensus decoder refuses as non-canonical; ' +
            'the federation is paying a fee for a wire no node will read');

        // Leg one: the wire's own field inflates to a body the publisher's own
        // builder reproduces byte for byte from the parsed content.
        assert.strictEqual(S.rebuiltBody, S.parsedWire.body,
            'the inflated body is not what OraclePublisher.buildPriceBatchBody produces for the ' +
            'same content, so the wire and the signed canonical describe different batches');

        // Leg two: the explicit round trip AT9 names.
        assert.ok(S.reInflated.ok,
            're-compressing the landed body produced a field the consensus module refuses: ' +
            (S.reInflated.reason || '?'));
        assert.strictEqual(S.reInflated.body, S.parsedWire.body,
            'body -> deflate -> base64 -> parse did NOT return the identical body; ' +
            'inflation is the one direction consensus depends on being deterministic');
        assert.strictEqual(Buffer.byteLength(S.reInflated.body, 'utf8'), S.parsedWire.bodyBytes);

        // The ratio is a measurement, so it has to be a real number and it has to
        // be inside the consensus cap that judges every node's inflate.
        assert.ok(Number.isFinite(S.parsedWire.ratio) && S.parsedWire.ratio > 1,
            'no compression ratio was measured for the landed wire');
        assert.ok(S.parsedWire.ratio <= priceBatch.PRICE_BATCH_MAX_INFLATE_RATIO,
            'the honest batch inflates at ' + S.parsedWire.ratio.toFixed(2) + ':1, past the consensus cap of ' +
            priceBatch.PRICE_BATCH_MAX_INFLATE_RATIO + ':1; every node would refuse it');
        assert.ok(S.parsedWire.bodyBytes <= priceBatch.PRICE_WIRE_MAX_BYTES,
            'the inflated body is ' + S.parsedWire.bodyBytes + ' B, past the reader bound of ' +
            priceBatch.PRICE_WIRE_MAX_BYTES + ' B. Compression buys FEE, not round capacity: a ' +
            'compressed wire under the encoder limit whose BODY is over this one is a fee spent ' +
            'on an action no indexing node will finish inflating.');
        assert.ok(S.parsedWire.wireBytes <= priceBatch.PRICE_WIRE_MAX_BYTES,
            'the emitted wire is ' + S.parsedWire.wireBytes + ' B, past the encoder limit');
    });

    it('both nodes stored the compressed batch as the same six-round batch', function () {
        for (const [label, rows] of [['live', S.liveRows], ['replay', S.replayRows]]) {
            const row = rows[S.landedTxid];
            assert.ok(row, 'the ' + label + ' node wrote no prices row for the batch');
            assert.strictEqual(Number(row.version), BATCH_WIRE_VERSION,
                'PARSE rung: the ' + label + ' node recorded PRICE version ' + row.version + ' for a batch wire');
            assert.strictEqual(Number(row.batch_first_round), S.parsedBody.firstRound,
                'the ' + label + ' node stored batch_first_round ' + row.batch_first_round +
                ' for a wire whose FIRST_ROUND is ' + S.parsedBody.firstRound);
            assert.strictEqual(Number(row.batch_last_round), S.parsedBody.lastRound);
            assert.strictEqual(Number(row.round_count), WINDOW_ROUNDS,
                'the ' + label + ' node stored round_count ' + row.round_count);
            assert.strictEqual(Number(row.round_number), S.parsedBody.firstRound,
                'D21: a batch row carries FIRST_ROUND in round_number');
            const storedRounds = JSON.parse(row.rounds_json || '[]');
            assert.strictEqual(storedRounds.length, WINDOW_ROUNDS,
                'the ' + label + ' node stored ' + storedRounds.length + ' round(s) in rounds_json');
        }
        assert.strictEqual(S.liveRows[S.landedTxid].status, S.replayRows[S.landedTxid].status,
            'the two nodes disagree about the honest batch: live "' + S.liveRows[S.landedTxid].status +
            '" vs replay "' + S.replayRows[S.landedTxid].status + '". A compressed wire that means two ' +
            'things is a fork.');
    });
};
