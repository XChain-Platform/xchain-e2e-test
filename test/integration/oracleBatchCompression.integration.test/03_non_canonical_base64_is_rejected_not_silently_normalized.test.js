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
const { STATUS_BASE64 } = require('./helpers/constants');

function registerCase1(S) {
    it('every non-canonical base64 spelling decodes to the SAME bytes under a lenient reader', function () {
        // The premise of the clause, established before the verdicts are read. A
        // spelling a lenient reader would REJECT anyway proves nothing about
        // strictness; these three are exactly the spellings Node's own
        // Buffer.from(s, 'base64') happily normalizes onto the canonical payload.
        for (const s of S.spellings) {
            assert.ok(s.strictRejects,
                'the "' + s.name + '" spelling is accepted by decodeCanonicalBase64, so it is not a ' +
                'non-canonical spelling at all and this clause tests nothing');
            assert.ok(s.lenientDecodesSame,
                'the "' + s.name + '" spelling does not decode to the canonical payload under a lenient ' +
                'reader, so rejecting it is not evidence about normalization. Rebuild the spelling.');
            assert.notStrictEqual(s.field, s.canonicalField);
        }
    });
}

function registerCase2(S) {
    it('every non-canonical base64 spelling is rejected ON CHAIN, on both nodes, with the base64 status', function () {
        for (const s of S.spellings) {
            const live = S.liveRows[s.landed.txid], replay = S.replayRows[s.landed.txid];
            assert.ok(live && replay, 'a node wrote no prices row for the "' + s.name + '" wire');
            assert.strictEqual(live.status, STATUS_BASE64,
                'the live node recorded "' + live.status + '" for the "' + s.name + '" spelling. ' +
                'Expected "' + STATUS_BASE64 + '". Any other status means the field got PAST the ' +
                'decoder, i.e. the spelling was silently normalized into the canonical payload and ' +
                'one wire now has two meanings.');
            assert.strictEqual(replay.status, live.status,
                'the two nodes disagree about the "' + s.name + '" spelling: live "' + live.status +
                '" vs replay "' + replay.status + '"');
            assert.strictEqual(live.validation_status, 'invalid');
            assert.strictEqual(replay.validation_status, 'invalid');
            // Not normalized: had it been, the ghost body would have been parsed and
            // its structure recorded.
            assert.strictEqual(live.rounds_json, null,
                'the live node stored round bodies for a "' + s.name + '" wire, so it decoded the ' +
                'non-canonical spelling after all');
            assert.strictEqual(replay.rounds_json, null,
                'the replay node stored round bodies for a "' + s.name + '" wire');
        }
    });
}

module.exports = function register(S) {
    // -----------------------------------------------------------------------
    // Clause 3: non-canonical base64 rejected, not silently normalized
    // -----------------------------------------------------------------------
    registerCase1(S);
    registerCase2(S);
};
