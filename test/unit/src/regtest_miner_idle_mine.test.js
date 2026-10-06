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

const RegtestMinerConnector = require('../../../src/regtest_miner_connector');

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
        const result = await connector.setIdleMineInterval(5000);
        assert.strictEqual(result, 'ok');
        const body = axiosPostStub.firstCall.args[1];
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

// The suite restores each miner's startup heartbeat at teardown, so the read side
// must report the miner's real value and never invent one it can be restored to.
describe('RegtestMinerConnector.getIdleMineInterval', function () {

    let connector, axiosPostStub;

    beforeEach(function () {
        axiosPostStub = sinon.stub(axios, 'post');
        connector = new RegtestMinerConnector('localhost', 18444);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('reads idle_mine_interval_ms from the miner status method', async function () {
        axiosPostStub.resolves({ data: { result: { wallet_ready: true, idle_mine_interval_ms: 60000 } } });
        assert.strictEqual(await connector.getIdleMineInterval(), 60000);
        assert.strictEqual(axiosPostStub.firstCall.args[1].method, 'status');
    });

    it('reports an off heartbeat as 0, not as unknown', async function () {
        axiosPostStub.resolves({ data: { result: { idle_mine_interval_ms: 0 } } });
        assert.strictEqual(await connector.getIdleMineInterval(), 0);
    });

    it('returns null when the status carries no usable interval', async function () {
        axiosPostStub.resolves({ data: { result: { wallet_ready: true } } });
        assert.strictEqual(await connector.getIdleMineInterval(), null);
        axiosPostStub.resolves({ data: { result: { idle_mine_interval_ms: '60000' } } });
        assert.strictEqual(await connector.getIdleMineInterval(), null);
    });

    it('throws when the status call itself fails', async function () {
        axiosPostStub.resolves({ data: { error: { code: -32601, message: 'Method not found' } } });
        await assert.rejects(() => connector.getIdleMineInterval(), /Method not found/);
    });
});
