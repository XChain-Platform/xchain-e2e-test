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
const drive = require('../../../helpers/oracleBatchDrive');
const { WINDOW_ROUNDS, VALIDATORS, MIN_SIGNATURES } = require('../helpers/pairs');

// Registers part of the assertions inside the caller's describe.
module.exports = function registerConsensus(ctx) {
    it('all eight rounds finalized on a real multi-signature quorum', function () {
        const { venue, signerSet, roundsA, roundsB } = ctx;
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
};
