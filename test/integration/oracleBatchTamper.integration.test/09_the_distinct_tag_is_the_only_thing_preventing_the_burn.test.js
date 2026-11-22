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
const state = require('./helpers/state');
const { addTest } = require('./helpers/suite');

addTest('the distinct tag is the ONLY thing preventing that burn: under one shared tag the same ' +
   'signatures DO slash', function () {
    const { parsed, sharedTagProof } = state;
    assert.ok(sharedTagProof,
        'the counterfactual was never built, so the refusal above is unfalsified: a harness that ' +
        'refuses everything would produce the same result');
    assert.strictEqual(sharedTagProof.status, 'valid',
        'the counterfactual recorded "' + sharedTagProof.status + '" rather than "valid". The two ' +
        'contents are the same real bodies, signed by the same real validator, wrapped under ONE ' +
        'XORACLE key at one anchor. If this does not slash, the assertion above proves nothing ' +
        'about the tag, because the harness refuses genuine equivocation too.');
    assert.strictEqual(sharedTagProof.calls.burns.length, 1,
        'the counterfactual reached "valid" without burning a bond (' +
        sharedTagProof.calls.burns.length + ' burn call(s))');
    assert.strictEqual(sharedTagProof.calls.events.length, 1,
        'the counterfactual burned without writing the capability_slash_event that makes the ' +
        'disqualification permanent');
    // The slot resolved at the BATCH ANCHOR, which is what makes the membership
    // lookup, and therefore the burn, a pure function of the proof.
    const lookup = sharedTagProof.calls.capabilityLookups.find((c) => c.capability === 'price');
    assert.ok(lookup, 'the counterfactual never resolved the `price` capability set');
    assert.strictEqual(Number(lookup.block), parsed.anchor,
        'membership resolved at block ' + lookup.block + ' rather than at the batch anchor ' +
        parsed.anchor + ', so the burn is not a pure function of the proof');
}, __filename);
