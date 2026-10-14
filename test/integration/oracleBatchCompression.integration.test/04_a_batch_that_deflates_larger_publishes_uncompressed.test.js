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
const { priceBatch, WINDOW_ROUNDS, BATCH_WIRE_VERSION, KNOWN_CAPABILITY_GAP_STATUS } = require('./helpers/constants');

module.exports = function register(S) {
    // -----------------------------------------------------------------------
    // Clause 4: a batch that deflates larger publishes uncompressed
    // -----------------------------------------------------------------------

    it('the publisher\'s emit-smaller decision is content-driven, not a constant', function () {
        assert.strictEqual(S.emitReal.compressed, true,
            'OraclePublisher.emitWire declined to compress the real six-round batch, whose body is ' +
            S.parsedWire.bodyBytes + ' B and whose packed form is ' + S.parsedWire.wireBytes + ' B');
        assert.strictEqual(S.emitEntropy.compressed, false,
            'OraclePublisher.emitWire compressed an INCOMPRESSIBLE body: the plain wire is ' +
            S.entropyPlainBytes + ' B and the packed wire is ' + S.entropyPackedBytes + ' B, so ' +
            'compressing it spends bytes to buy nothing');
        assert.ok(S.entropyPackedBytes >= S.entropyPlainBytes,
            'the incompressible body is not actually incompressible (' + S.entropyPackedBytes +
            ' B packed vs ' + S.entropyPlainBytes + ' B plain), so this clause proves nothing. ' +
            'entropyString drew from too small an alphabet.');
        assert.strictEqual(S.emitEntropy.bytes, S.entropyPlainBytes,
            'emitWire returned ' + S.emitEntropy.bytes + ' B for a body whose plain wire is ' +
            S.entropyPlainBytes + ' B');
        const emittedFields = String(S.emitEntropy.wire).split('|');
        assert.strictEqual(emittedFields[0], 'PRICE');
        assert.strictEqual(parseInt(emittedFields[1], 10), BATCH_WIRE_VERSION);
        assert.notStrictEqual(emittedFields[2], priceBatch.PRICE_BATCH_COMPRESSION_MARKER,
            'the emitted wire carries the compression marker in the FIRST_ROUND slot even though ' +
            'emitWire reported the uncompressed form; the two halves of the decision disagree');
    });

    it('the uncompressed wire form is a first-class wire: the plain twin lands the identical batch', function () {
        // The same signed body, in the other form, on the same chain. If the two
        // forms could diverge in validity, this is where it would show: the
        // compressed original and its plain twin must produce the same stored
        // batch on both nodes.
        const original = S.liveRows[S.landedTxid];
        for (const [label, rows] of [['live', S.liveRows], ['replay', S.replayRows]]) {
            const twin = rows[S.plainTwin.txid];
            assert.ok(twin, 'the ' + label + ' node wrote no prices row for the uncompressed twin');
            assert.ok(!/^invalid: COMPRESSION/.test(String(twin.status)),
                'the ' + label + ' node recorded "' + twin.status + '" for an UNCOMPRESSED wire; a wire ' +
                'with no `Z` marker must never reach the decompression path at all');
            assert.strictEqual(Number(twin.version), BATCH_WIRE_VERSION);
            assert.strictEqual(Number(twin.batch_first_round), S.parsedBody.firstRound);
            assert.strictEqual(Number(twin.batch_last_round), S.parsedBody.lastRound);
            assert.strictEqual(Number(twin.round_count), WINDOW_ROUNDS);
            assert.strictEqual(twin.rounds_json, rows[S.landedTxid].rounds_json,
                'the ' + label + ' node stored different round bodies for the two wire forms of ONE ' +
                'signed batch. Everything downstream of decompression is meant to be form-agnostic.');
            assert.strictEqual(twin.sigs_json, rows[S.landedTxid].sigs_json,
                'the ' + label + ' node stored a different signature set for the two wire forms');
        }
        assert.strictEqual(S.liveRows[S.plainTwin.txid].status, S.replayRows[S.plainTwin.txid].status,
            'the two nodes disagree about the uncompressed twin');
        // The verdict itself is not AT9's claim, but a twin that validates
        // differently from its compressed original IS: same bytes, same rules.
        assert.strictEqual(S.liveRows[S.plainTwin.txid].status, original.status,
            'the compressed batch recorded "' + original.status + '" and its own uncompressed twin ' +
            'recorded "' + S.liveRows[S.plainTwin.txid].status + '". The two wire forms are one action ' +
            'in two spellings; a validity difference between them is a fork.' +
            (original.status === KNOWN_CAPABILITY_GAP_STATUS
                ? ' (Both carry the known price-capability verdict, which AT9 does not judge.)' : ''));
    });
};
