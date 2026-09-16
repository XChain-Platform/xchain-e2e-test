'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// The miner is mempool-driven, so an idle chain gains no height and a
// test that WAITS OUT a height window (stake ACTIVATION_DELAY_BLOCKS,
// confirmation depth) hangs with nothing in flight. The connector wrapper for
// the miner's mine-empty heartbeat is pinned here because a typo in the method
// or param name is otherwise silent: express-json-rpc-router answers an unknown
// method with a top-level error the caller could easily read as a null success.

const assert = require('assert');
const sinon  = require('sinon');
const axios  = require('axios');

const RegtestMinerConnector = require('../../../src/RegtestMinerConnector');

describe('RegtestMinerConnector.setIdleMineInterval', function () {

    let connector, axiosPostStub;

    beforeEach(function () {
        axiosPostStub = sinon.stub(axios, 'post');
        connector = new RegtestMinerConnector('localhost', 18444);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('calls set_idle_mine_interval with interval_ms, matching the miner controller', async function () {
        axiosPostStub.resolves({ data: { result: 'ok' } });
        let result = await connector.setIdleMineInterval(5000);
        assert.strictEqual(result, 'ok');
        let body = axiosPostStub.firstCall.args[1];
        assert.strictEqual(body.method, 'set_idle_mine_interval');
        assert.deepStrictEqual(body.params, { interval_ms: 5000 });
    });

    it('passes 0 through to disable the heartbeat', async function () {
        axiosPostStub.resolves({ data: { result: 'ok' } });
        await connector.setIdleMineInterval(0);
        assert.deepStrictEqual(axiosPostStub.firstCall.args[1].params, { interval_ms: 0 });
    });

    it('throws on a rejected interval instead of reading it as green', async function () {
        axiosPostStub.resolves({ data: { result: { error: 'Idle mine interval too small. Minimum is 1000ms (0 disables).' } } });
        await assert.rejects(() => connector.setIdleMineInterval(10), /too small/);
    });

    it('throws when the miner is too old to know the method (version skew)', async function () {
        axiosPostStub.resolves({ data: { error: { code: -32601, message: 'Method not found' } } });
        await assert.rejects(() => connector.setIdleMineInterval(5000), /Method not found/);
    });
});
