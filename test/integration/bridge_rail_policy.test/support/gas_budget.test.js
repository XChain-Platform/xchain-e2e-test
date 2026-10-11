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

const { planBootstrapGas } = require('./gas_budget');

describe('policy rail bootstrap gas budget', function () {
    const faucet = [
        { address: 'a', balance: '2285400' },
        { address: 'b', balance: '2381550' },
        { address: 'c', balance: '2583006' },
    ];

    it('refuses a spent supply whose faucet and donors fall short, naming each source', function () {
        // The venue reading that sent a MINT into MAX_SUPPLY after a 24 minute bootstrap.
        const plan = planBootstrapGas({
            need: 5 * (1541000 + 1000),
            faucet,
            donors: [7740n, 90n],
            supply: { supply: '100000000', maxSupply: '100000000' },
        });
        assert.strictEqual(plan.ok, false);
        assert.match(plan.reason, /need 7710000 XCHAIN/);
        assert.match(plan.reason, /donors 7830/);
        assert.match(plan.reason, /faucet 7249956 across 3 holder\(s\)/);
        assert.match(plan.reason, /MINT headroom 0 \(supply 100000000 of 100000000\)/);
        assert.match(plan.reason, /short by 452214/);
    });

    it('passes when MINT headroom covers what the faucet cannot', function () {
        const plan = planBootstrapGas({
            need: 7710000,
            faucet,
            donors: [],
            supply: { supply: '99000000', maxSupply: '100000000' },
        });
        assert.strictEqual(plan.ok, true);
        assert.strictEqual(plan.reason, null);
    });

    it('passes on an unreadable supply, leaving the MINT for the indexer to grade', function () {
        const plan = planBootstrapGas({ need: 7710000, faucet: [], donors: [], supply: null });
        assert.strictEqual(plan.ok, true);
        assert.match(plan.summary, /MINT headroom unreadable/);
    });

    it('counts the exact boundary as enough', function () {
        const plan = planBootstrapGas({
            need: 100,
            faucet: [{ address: 'a', balance: '60' }],
            donors: ['40'],
            supply: { supply: '5', maxSupply: '5' },
        });
        assert.strictEqual(plan.ok, true);
    });
});
