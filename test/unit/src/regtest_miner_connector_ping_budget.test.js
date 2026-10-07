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

const assert = require('assert');
const sinon  = require('sinon');
const axios  = require('axios');

// Each readiness ping gets only the budget left, so waitForReady(timeoutMs) is a real bound.
const RegtestMinerConnector = require('../../../src/regtest_miner_connector');

const URL  = 'localhost';
const PORT = 18444;

let connector;
let axiosPostStub;

function setupConnector() {
    axiosPostStub = sinon.stub(axios, 'post');
    connector = new RegtestMinerConnector(URL, PORT);
}

function teardownConnector() {
    sinon.restore();
}

describe('RegtestMinerConnector', function () {
    beforeEach(setupConnector);
    afterEach(teardownConnector);
    describe('waitForReady', function () {
        it('hands each ping no more than the budget left', async function () {
            const budgets = [];
            sinon.stub(connector, 'ping').callsFake(async (ms) => { budgets.push(ms); return false; });
            sinon.stub(connector, 'sleep').callsFake(async () => {});

            assert.strictEqual(await connector.waitForReady(50, 10), false);

            assert.ok(budgets.length > 0, 'expected at least one ping');
            assert.ok(budgets.every((ms) => typeof ms === 'number' && ms <= 50),
                'a ping got more than the 50ms budget: ' + budgets.join(','));
        });

        // A miner that accepts the socket and never answers: each request rejects only
        // when its own axios timeout fires, so the total wait is what the caller sees.
        it('returns within its timeout against a miner that never answers', async function () {
            this.timeout(10000);
            axiosPostStub.callsFake((url, data, cfg) => new Promise((resolve, reject) => {
                setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })), cfg.timeout);
            }));

            const t0 = Date.now();
            assert.strictEqual(await connector.waitForReady(200, 50), false);
            const took = Date.now() - t0;
            assert.ok(took < 200 + 150, 'waitForReady(200) took ' + took + 'ms');
        });
    });
});

describe('RegtestMinerConnector', function () {
    beforeEach(setupConnector);
    afterEach(teardownConnector);
    describe('ping budget', function () {
        it('sends the full cap when called with no budget', async function () {
            axiosPostStub.resolves({ data: { result: { ready: true } } });
            await connector.ping();
            assert.strictEqual(axiosPostStub.firstCall.args[2].timeout, 5000);
        });

        it('sends a smaller budget through unchanged', async function () {
            axiosPostStub.resolves({ data: { result: { ready: true } } });
            await connector.ping(1234);
            assert.strictEqual(axiosPostStub.firstCall.args[2].timeout, 1234);
        });

        // axios reads timeout 0 as "no timeout", which would bring back the unbounded hang.
        it('never sends a zero or negative timeout, and never raises the cap', async function () {
            axiosPostStub.resolves({ data: { result: { ready: true } } });
            await connector.ping(0);
            await connector.ping(-5);
            await connector.ping(999999);
            await connector.ping(NaN);
            const sent = axiosPostStub.getCalls().map((c) => c.args[2].timeout);
            assert.deepStrictEqual(sent, [1, 1, 5000, 5000]);
        });
    });
});

