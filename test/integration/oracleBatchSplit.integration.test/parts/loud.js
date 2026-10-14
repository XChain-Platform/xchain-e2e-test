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
const { WINDOW_ROUNDS } = require('../helpers/pairs');

// Registers part of the assertions inside the caller's describe.
module.exports = function registerLoud(ctx) {
    it('the ceiling was LOUD: a CRITICAL line naming the round and the bound it breached', function () {
        const { venue, errorLines } = ctx;
        const bigRound = venue.roundBase + WINDOW_ROUNDS + 2;
        const criticals = errorLines.filter((l) => /OraclePublisher: CRITICAL/.test(l));
        assert.ok(criticals.length >= 1,
            'the rail refused a round and logged no CRITICAL line at all. The counter and the ' +
            'dead-letter are machine-checkable, but section 8 makes the log line the deliverable an ' +
            'operator actually sees, and the hub has no other alerting rail. Lines captured: ' +
            errorLines.length);
        const named = criticals.filter((l) => l.indexOf(String(bigRound)) !== -1);
        assert.ok(named.length >= 1,
            'a CRITICAL line was logged but none names round ' + bigRound + '; an alert that does not ' +
            'say WHICH round is unpublishable cannot be acted on. Captured CRITICAL lines: ' +
            criticals.map((l) => l.split('\n')[0]).join(' || '));
        assert.ok(/8189/.test(named[0]) && /does not fit/i.test(named[0]),
            'the CRITICAL line for round ' + bigRound + ' does not state the byte limit it breached: "' +
            named[0].split('\n')[0] + '"');
    });
};
