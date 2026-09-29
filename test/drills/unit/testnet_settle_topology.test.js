/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { readSettleTopology } = require('../lib/testnetSettleTopology');

describe('testnet settlement topology', function () {
    it('pins all five validators to the testnet P2P port and quorum floor', function () {
        const topology = readSettleTopology({ TESTNET_EXPLORER_URL: 'https://explorer.example' });

        assert.deepStrictEqual(topology.validators, {
            hosts: [
                'validator01.xchain.io',
                'validator02.xchain.io',
                'validator03.xchain.io',
                'validator04.xchain.io',
                'validator05.xchain.io'
            ],
            port: 10002,
            minLive: 4
        });
        assert.strictEqual(topology.btcCoin, 'TBTC');
        assert.strictEqual(topology.dogeCoin, 'TDOGE');
    });

    it('budgets at least one hour for every live-network phase', function () {
        const topology = readSettleTopology({ TESTNET_EXPLORER_URL: 'https://explorer.example' });

        assert.deepStrictEqual(topology.deadlines, {
            inclusionMs: 3600000,
            matchMs: 7200000,
            settleMs: 10800000
        });
        for (const deadline of Object.values(topology.deadlines)) {
            assert.ok(deadline >= 3600000);
        }
    });

    it('requires the explorer URL from the caller instead of process.env', function () {
        const previous = process.env.TESTNET_EXPLORER_URL;
        process.env.TESTNET_EXPLORER_URL = 'https://ignored.example';

        try {
            assert.throws(() => readSettleTopology({}), /TESTNET_EXPLORER_URL/);
        } finally {
            if (previous === undefined) delete process.env.TESTNET_EXPLORER_URL;
            else process.env.TESTNET_EXPLORER_URL = previous;
        }
    });

    it('returns frozen topology data', function () {
        const topology = readSettleTopology({ TESTNET_EXPLORER_URL: 'https://explorer.example' });

        assert.strictEqual(Object.isFrozen(topology), true);
        assert.strictEqual(Object.isFrozen(topology.validators), true);
        assert.strictEqual(Object.isFrozen(topology.validators.hosts), true);
        assert.strictEqual(Object.isFrozen(topology.deadlines), true);
    });
});
