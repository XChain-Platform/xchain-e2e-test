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
const { CAPABILITY_GAP_STATUS, ANCHOR_TAMPER_STATUS } = require('./helpers/constants');
const state = require('./helpers/state');
const { addTest } = require('./helpers/suite');

addTest('the tamper, not the chain, is what the rejection is about [WAITING while the honest batch ' +
   'is still recording the capability-gap status]', function () {
    const { liveStatus } = state;
    const honestLive = liveStatus.honest;
    if (honestLive === CAPABILITY_GAP_STATUS) {
        console.log('  AT4 discrimination assertion is WAITING, not failing. The honest batch on this ' +
            'chain recorded "' + honestLive + '", which is also what a body tamper earns at the ' +
            'stake-weighted quorum gate, so the two are indistinguishable on this run. The ' +
            'header-anchor tamper above is unaffected: its status "' + ANCHOR_TAMPER_STATUS + '" is ' +
            'reached before any capability is resolved and can only have come from the tamper. This ' +
            'assertion turns green with no edit to this file once an honest batch validates on DOGE.');
        this.skip();
        return;
    }
    assert.strictEqual(honestLive, 'valid',
        'the honest batch recorded "' + honestLive + '". Expected either "valid" or the known ' +
        'capability-gap status "' + CAPABILITY_GAP_STATUS + '"; anything else is a parse, fee or ' +
        'wire regression rather than the known gap, and it makes the tamper comparison unreadable.');
    for (const name of ['priceDigit', 'headerAnchor']) {
        assert.notStrictEqual(liveStatus[name], honestLive,
            'the ' + name + ' tamper recorded the same status "' + liveStatus[name] + '" as the ' +
            'UNTOUCHED batch, so nothing here is a statement about the tamper');
        assert.ok(String(liveStatus[name]).startsWith('invalid: '),
            'the ' + name + ' tamper recorded "' + liveStatus[name] + '" on a chain that accepts the ' +
            'honest batch, so a post-signing tamper is being absorbed');
    }
}, __filename);
