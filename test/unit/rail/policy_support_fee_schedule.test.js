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
 *********************************************************************/

'use strict';

const assert = require('assert');

const policy = require('../../integration/bridge_rail_policy.test/support/policy');
const { feeScheduleBudgetMs } = require('../../helpers/rail_preflight/policy_at7_at8');

function boundPolicy(pollMs) {
    const waits = [];
    const venue = {
        waitUntil: async (what, check, options) => { waits.push(options); },
    };
    if (pollMs !== undefined) venue.pollMs = pollMs;
    const state = { venue, dogeRail: { env: {} } };
    const T = { fundDoge: async () => ({}) };
    return { bound: policy.bind(state, T), waits };
}

describe('policy support DOGE fee schedule wait', function () {
    it('uses the fee schedule budget for the venue poll cadence', async function () {
        const standard = boundPolicy(15000);
        await standard.bound.fundDoge('POLICY.FEE', 1);
        assert.strictEqual(standard.waits[0].timeoutMs, feeScheduleBudgetMs(15000));
        assert.strictEqual(standard.waits[0].timeoutMs, 600000);

        const slow = boundPolicy(600000);
        await slow.bound.fundDoge('POLICY.FEE', 1);
        assert.strictEqual(slow.waits[0].timeoutMs, feeScheduleBudgetMs(600000));
    });

    it('uses the 15000 ms cadence when pollMs is missing', async function () {
        const recorded = boundPolicy();
        await recorded.bound.fundDoge('POLICY.FEE', 1);
        assert.strictEqual(recorded.waits[0].timeoutMs, feeScheduleBudgetMs(15000));
    });

    it('keeps the 2000 ms poll interval', async function () {
        const recorded = boundPolicy(15000);
        await recorded.bound.fundDoge('POLICY.FEE', 1);
        assert.strictEqual(recorded.waits[0].everyMs, 2000);
    });

    it('waits only once for two fundDoge calls on one state', async function () {
        const recorded = boundPolicy(15000);
        await recorded.bound.fundDoge('POLICY.FEE', 1);
        await recorded.bound.fundDoge('POLICY.FEE', 1);
        assert.strictEqual(recorded.waits.length, 1);
    });
});
