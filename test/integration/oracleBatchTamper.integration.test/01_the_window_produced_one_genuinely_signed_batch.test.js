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
const { ValidatorIdentity } = require('../../helpers/oracleBatchVenue');
const { WINDOW_ROUNDS, VALIDATORS, MIN_SIGNATURES } = require('./helpers/constants');
const state = require('./helpers/state');
const { addTest } = require('./helpers/suite');

addTest('the window produced ONE genuinely signed batch, on a real quorum, before anything was touched', function () {
    const { rounds, parsed, batchCanonical } = state;
    assert.strictEqual(rounds.length, WINDOW_ROUNDS,
        'expected ' + WINDOW_ROUNDS + ' finalized rounds, got ' + rounds.length);
    assert.ok(parsed.ok, 'the honest wire does not parse: ' + parsed.reason);
    assert.strictEqual(parsed.roundCount, WINDOW_ROUNDS,
        'the honest batch covers ' + parsed.roundCount + ' round(s), not ' + WINDOW_ROUNDS);
    const distinct = new Set(parsed.sigs.map((s) => s.pubkey));
    assert.strictEqual(distinct.size, parsed.sigs.length, 'the honest wire carries a duplicate signer');
    assert.ok(distinct.size >= MIN_SIGNATURES,
        'SIGNING ROUND rung: the honest batch carries only ' + distinct.size + ' signature(s); a ' +
        'weighted quorum over ' + VALIDATORS + ' equal sources needs ' + MIN_SIGNATURES + '. There is ' +
        'no signed artifact to tamper with below that.');
    // Every signature on the wire verifies over the canonical the signing round
    // built. This is the baseline the tamper is measured against: it establishes
    // that what follows breaks something that was genuinely intact.
    let verified = 0;
    for (const s of parsed.sigs) if (ValidatorIdentity.verify(batchCanonical, s.sig, s.pubkey)) verified++;
    assert.strictEqual(verified, parsed.sigs.length,
        'only ' + verified + ' of ' + parsed.sigs.length + ' signatures on the honest wire verify ' +
        'against the batch canonical, so the batch was not intact before the tamper');
}, __filename);
