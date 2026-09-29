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
const { policyApplyBudgetMs } = require('../../helpers/rail_preflight/policy_at2_at4');
const { policyFinalizationBudgetMs } = require('../../helpers/rail_preflight/policy_at7_at8');

// Each wait is bound to a stub venue whose waitUntil only records its options, so the
// budget is read without a rail or a hub database.
function recordedWait(method, venue, opts) {
    let recorded = null;
    const stub = Object.assign({}, venue, {
        waitUntil: async (what, check, options) => { recorded = options; },
    });
    const bound = policy.bind({ venue: stub }, {});
    return bound[method]('POLA', 1, opts).then(() => recorded);
}

describe('policy support finalized-snapshot wait', function () {
    it('defaults to the policy finalization budget of the venue poll cadence', async function () {
        const short = await recordedWait('waitForFinalizedSeq', { pollMs: 15000 });
        assert.strictEqual(short.timeoutMs, policyFinalizationBudgetMs(15000));
        assert.strictEqual(short.timeoutMs, 1800000);

        const long = await recordedWait('waitForFinalizedSeq', { pollMs: 600000 });
        assert.strictEqual(long.timeoutMs, policyFinalizationBudgetMs(600000));
        assert.strictEqual(long.timeoutMs, 3600000);
    });

    it('reads the 15000 ms cadence when the venue has no pollMs', async function () {
        const recorded = await recordedWait('waitForFinalizedSeq', {});
        assert.strictEqual(recorded.timeoutMs, policyFinalizationBudgetMs(15000));
    });

    it('passes an explicit timeoutMs through unchanged', async function () {
        const recorded = await recordedWait('waitForFinalizedSeq', { pollMs: 600000 }, { timeoutMs: 1234 });
        assert.strictEqual(recorded.timeoutMs, 1234);
    });

    it('keeps the 5000 ms poll interval', async function () {
        const recorded = await recordedWait('waitForFinalizedSeq', { pollMs: 15000 });
        assert.strictEqual(recorded.everyMs, 5000);
    });
});

describe('policy support applied-sequence wait', function () {
    it('defaults to the DOGE policy apply budget', async function () {
        const recorded = await recordedWait('waitForAppliedSeq', { pollMs: 15000 });
        assert.strictEqual(recorded.timeoutMs, policyApplyBudgetMs('DOGE'));
        assert.strictEqual(recorded.timeoutMs, 2100000);
    });

    it('passes an explicit timeoutMs through unchanged', async function () {
        const recorded = await recordedWait('waitForAppliedSeq', { pollMs: 15000 }, { timeoutMs: 1234 });
        assert.strictEqual(recorded.timeoutMs, 1234);
    });

    it('keeps the 5000 ms poll interval', async function () {
        const recorded = await recordedWait('waitForAppliedSeq', { pollMs: 15000 });
        assert.strictEqual(recorded.everyMs, 5000);
    });
});
