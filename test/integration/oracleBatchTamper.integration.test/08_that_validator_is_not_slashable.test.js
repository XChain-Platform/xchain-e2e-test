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
const { TAG_SEPARATION_STATUS } = require('./helpers/constants');
const state = require('./helpers/state');
const { addTest } = require('./helpers/suite');

addTest('that validator is NOT slashable: the proof is refused and no bond is burned', function () {
    const { honestProof, swappedProof } = state;
    assert.ok(honestProof, 'no slash decision was reached for the honest pair');
    assert.strictEqual(honestProof.status, TAG_SEPARATION_STATUS,
        'SLASH recorded "' + honestProof.status + '" for a validator that signed one honest ' +
        'per-round canonical and one honest batch at the same anchor. Expected "' +
        TAG_SEPARATION_STATUS + '": the two carry different engine tags, so they cannot share an ' +
        'equiv key and cannot be paired as equivocation.');
    assert.strictEqual(honestProof.calls.burns.length, 0,
        'a bond was burned for an honest validator (' + honestProof.calls.burns.length + ' burn call(s))');
    assert.strictEqual(honestProof.calls.events.length, 0,
        'a capability_slash_event was written for an honest validator, which disqualifies its key ' +
        'from every capability permanently');
    // Order must not matter: whichever message the submitter puts first, the
    // prefix comes from MSG_A and the other cannot match it.
    assert.strictEqual(swappedProof.status, TAG_SEPARATION_STATUS,
        'with the two messages swapped SLASH recorded "' + swappedProof.status + '", so the refusal ' +
        'depends on which one the submitter names first');
    assert.strictEqual(swappedProof.calls.burns.length, 0,
        'swapping the message order burned a bond');
}, __filename);
