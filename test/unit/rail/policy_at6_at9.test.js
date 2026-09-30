'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Pins the rail's expected copy-ISSUE refusal to the indexer's own tick rules, and
// checks the policy AT3 and AT9 cases assert that verdict rather than a stale literal.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { COPY_ISSUE_REFUSED } = require('../../helpers/rail_preflight/copy_issue_verdict');
const tickRules = require('../../../../xchain-indexer/src/actions/issue/tick_rules.js');

const POLICY_DIR = path.resolve(__dirname, '..', '..', 'integration', 'bridge_rail_policy.test');
const CASE_FILES = ['03_at3_the_copy_is_editable_by_no_key.test.js', '08_at9_controller_bindings_stay_refused.test.js'];

function handler(parentOwner) {
    return {
        actions: { protocolChanges: { isEnabled: async () => true } },
        util: { isNull: (v) => v === null || v === undefined || v === '' },
        parentGetTokenInfo: async () => ({ OWNER: parentOwner }),
        indexerDb: { isOwnershipEscrowed: async () => false },
    };
}

async function tickVerdict(source, parentOwner) {
    const ctx = {
        data: { TICK: 'BTC.FUFU', SOURCE: source, BLOCK_INDEX: 100, ACTION_INDEX: 1 },
        allowedCharacters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.'.split(''),
        tickCharacters: 'BTC.FUFU'.split(''),
        error: null,
    };
    await tickRules.validateTickName.call(handler(parentOwner), ctx);
    return ctx.error;
}

describe('bridged copy ISSUE verdict', function () {
    it('is the verdict the indexer gives a key that does not own the copy root', async function () {
        assert.strictEqual(await tickVerdict('user', 'bridge-role'), COPY_ISSUE_REFUSED);
    });

    it('comes from the parent check alone, so the root owner passes it', async function () {
        assert.strictEqual(await tickVerdict('bridge-role', 'bridge-role'), null);
    });

    for (const file of CASE_FILES) {
        it(file + ' asserts that verdict, not the tick-owner literal', function () {
            const text = fs.readFileSync(path.join(POLICY_DIR, file), 'utf8');
            assert.ok(text.includes('COPY_ISSUE_REFUSED'), file + ' does not assert COPY_ISSUE_REFUSED');
            assert.ok(!text.includes("'invalid: issued by another address'"),
                file + ' still expects the tick-owner verdict the indexer never reaches on a copy');
        });
    }
});

describe('policy AT6 burn while the tick sleeps', function () {
    const text = () => fs.readFileSync(path.join(POLICY_DIR, '06_at6_the_origin_sleep_reaches_the_copy.test.js'), 'utf8');
    const burnCase = () => text().split("it('policy AT6 (burn)")[1].split("it('policy AT6 (wake)")[0];

    it('expects the refusal the indexer gives a v4 burn of a sleeping copy (operator ruling 2026-09-29)', function () {
        assert.ok(/burn\.status, 'invalid: TICK \(sleeping\)'/.test(burnCase()),
            'the AT6 burn case does not assert invalid: TICK (sleeping)');
        assert.ok(!/burn\.status, 'valid'/.test(burnCase()), 'the AT6 burn case still expects the burn to apply');
    });

    it('still proves the refused burn moved no balance on either chain', function () {
        assert.ok(/Number\(after\), Number\(before\)/.test(burnCase()), 'the copy holder balance is not compared');
        assert.ok(/Number\(received\), 0/.test(burnCase()), 'the BTC receiver balance is not checked');
    });
});
