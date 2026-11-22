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

addTest('both tampered wires landed on the chain, in their own blocks, from the same rail', function () {
    const { landed } = state;
    for (const name of ['priceDigit', 'headerAnchor']) {
        const l = landed[name];
        assert.ok(l && /^[0-9a-f]{64}$/.test(String(l.txid)),
            'PUSH rung: the ' + name + ' tamper did not return a transaction id');
        assert.ok(Number.isFinite(l.height),
            'PUSH rung: the ' + name + ' tamper transaction ' + l.txid + ' is not in a block');
    }
    const heights = ['honest', 'priceDigit', 'headerAnchor'].map((n) => landed[n].height);
    assert.strictEqual(new Set(heights).size, heights.length,
        'two of this drill\'s three PRICE actions share a block (heights ' + heights.join(', ') +
        '), so a per-block verdict lookup cannot attribute them. Each broadcast waits for the ' +
        'previous one to be mined, so this means the chain reorganised or the miner batched them.');
}, __filename);
