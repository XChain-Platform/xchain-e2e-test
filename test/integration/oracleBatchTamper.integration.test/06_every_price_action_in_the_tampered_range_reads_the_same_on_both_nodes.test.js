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

addTest('every PRICE action in the tampered block range reads the same on both nodes', function () {
    const { priceRowDiff, liveDbError, minBlock, targetHeight } = state;
    if (!priceRowDiff) {
        assert.fail('the live node\'s PRICE rows could not be read (' + liveDbError + '), so the ' +
            'range-wide half of the cross-node claim was never measured. The per-transaction ' +
            'assertions above still stand on the venue\'s own indexer read.');
    }
    assert.strictEqual(priceRowDiff.disagreed.length, 0,
        'CONSENSUS: ' + priceRowDiff.disagreed.length + ' of ' + priceRowDiff.compared +
        ' PRICE action(s) in blocks ' + minBlock + '..' + targetHeight + ' were decided differently ' +
        'by the live node and the replaying node: ' +
        priceRowDiff.disagreed.slice(0, 5).map((d) => d.at + ' live "' + d.live + '" replay "' +
            d.replay + '"').join('; '));
    assert.strictEqual(priceRowDiff.missing.length, 0,
        'the replaying node holds no PRICE action at ' + priceRowDiff.missing.slice(0, 5).join(', ') +
        ', which the live node decided; a batch the chain carries must be judged by every node ' +
        'that walks it, valid or not');
    assert.ok(priceRowDiff.compared >= 3,
        'only ' + priceRowDiff.compared + ' PRICE action(s) were compared, but this drill landed 3');
}, __filename);
