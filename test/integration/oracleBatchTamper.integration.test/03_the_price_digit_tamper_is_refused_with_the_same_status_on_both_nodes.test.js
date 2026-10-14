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

addTest('the price-digit tamper is refused with the SAME status string on both nodes', function () {
    const { landed, liveStatus, replayStatus } = state;
    const live   = liveStatus.priceDigit;
    const replay = replayStatus.priceDigit;
    assert.ok(replay !== null,
        'the replaying node recorded NO PRICE action at block ' + landed.priceDigit.height +
        ', so it never judged the tampered wire at all');
    assert.ok(String(live).startsWith('invalid: '),
        'the live node recorded "' + live + '" for a batch whose body was altered after signing; ' +
        'a tampered batch must never be accepted');
    assert.strictEqual(replay, live,
        'CONSENSUS: the two nodes disagree about a tampered batch. Live recorded "' + live +
        '", the replaying node recorded "' + replay + '". Both walked the same block ' +
        landed.priceDigit.height + ' with the same bytes, so this is a fork in the PRICE parser.');
}, __filename);
