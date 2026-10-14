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
const { ANCHOR_TAMPER_STATUS } = require('./helpers/constants');
const state = require('./helpers/state');
const { addTest } = require('./helpers/suite');

addTest('the header-anchor tamper is refused with the SAME status string on both nodes, and that ' +
   'string can only have come from the tamper', function () {
    const { landed, liveStatus, replayStatus } = state;
    const live   = liveStatus.headerAnchor;
    const replay = replayStatus.headerAnchor;
    assert.ok(replay !== null,
        'the replaying node recorded NO PRICE action at block ' + landed.headerAnchor.height);
    assert.strictEqual(live, ANCHOR_TAMPER_STATUS,
        'the live node recorded "' + live + '" for a batch whose header anchor was moved off the ' +
        'last round\'s anchor. Section 4 pins those equal and price/index.js checks it structurally, ' +
        'BEFORE the straddle rule and both quorum gates, so the expected verdict is "' +
        ANCHOR_TAMPER_STATUS + '". Anything else means the check moved or stopped running.');
    assert.strictEqual(replay, live,
        'CONSENSUS: live recorded "' + live + '" and the replaying node recorded "' + replay +
        '" for the same bytes in block ' + landed.headerAnchor.height);
}, __filename);
