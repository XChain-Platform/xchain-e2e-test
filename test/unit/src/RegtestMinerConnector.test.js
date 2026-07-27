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

const RegtestMinerConnector = require('../../../src/RegtestMinerConnector');

describe('RegtestMinerConnector', function () {

    const URL  = 'localhost';
    const PORT = 18444;

    let connector;
    let axiosPostStub;

    beforeEach(function () {
        axiosPostStub = sinon.stub(axios, 'post');
        connector = new RegtestMinerConnector(URL, PORT);
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('constructor', function () {
        it('builds the URL as http://{url}:{port}', function () {
            assert.strictEqual(connector.url, `http://${URL}:${PORT}`);
        });

        it('stores port', function () {
            assert.strictEqual(connector.port, PORT);
        });

        it('sends no auth header by default (two-arg construction unchanged)', async function () {
            assert.deepStrictEqual(connector.reqConfig, {});
            axiosPostStub.resolves({ data: { result: 'pong' } });
            await connector.sendFunds('addr', 1);
            assert.deepStrictEqual(axiosPostStub.firstCall.args[2], {});
        });

        it('attaches the x-api-key header to every request when a key is configured', async function () {
            const keyed = new RegtestMinerConnector(URL, PORT, 'secret-key');
            assert.deepStrictEqual(keyed.reqConfig, { headers: { 'x-api-key': 'secret-key' } });
            axiosPostStub.resolves({ data: { result: 'ok' } });
            await keyed.generateBlocks(1);
            assert.deepStrictEqual(axiosPostStub.firstCall.args[2], { headers: { 'x-api-key': 'secret-key' } });
        });
    });

    describe('ping', function () {
        it('returns true when response.data.result.ready is true', async function () {
            // ping() gates on result.ready (the df6a8f7 readiness gate), not bare
            // result truthiness, so a cold-start miner whose port listens before the
            // wallet is funded is not reported ready.
            axiosPostStub.resolves({ data: { result: { ready: true } } });
            const result = await connector.ping();
            assert.strictEqual(result, true);
        });

        it('returns false when response.data.result is falsy', async function () {
            axiosPostStub.resolves({ data: { result: null } });
            const result = await connector.ping();
            assert.strictEqual(result, false);
        });

        it('returns false when response.data is missing result', async function () {
            axiosPostStub.resolves({ data: {} });
            const result = await connector.ping();
            assert.strictEqual(result, false);
        });

        it('returns false when axios throws', async function () {
            axiosPostStub.rejects(new Error('connection refused'));
            const result = await connector.ping();
            assert.strictEqual(result, false);
        });

        it('sends JSON-RPC ping payload to the correct URL', async function () {
            axiosPostStub.resolves({ data: { result: 'pong' } });
            await connector.ping();

            const [url, data] = axiosPostStub.firstCall.args;
            assert.strictEqual(url, connector.url);
            assert.strictEqual(data.jsonrpc, '2.0');
            assert.strictEqual(data.method, 'ping');
            assert.strictEqual(data.id, 1);
        });
    });

    describe('sendFunds', function () {
        const ADDRESS = 'bcrt1qtest';
        const AMOUNT  = 1.5;
        const TX_HASH = 'txhash123';

        it('sends the correct JSON-RPC payload', async function () {
            axiosPostStub.resolves({ data: { result: TX_HASH } });

            await connector.sendFunds(ADDRESS, AMOUNT);

            const [url, data] = axiosPostStub.firstCall.args;
            assert.strictEqual(url, connector.url);
            assert.strictEqual(data.jsonrpc, '2.0');
            assert.strictEqual(data.method, 'send_funds');
            assert.strictEqual(data.id, 1);
            assert.deepStrictEqual(data.params, { address: ADDRESS, amount: AMOUNT });
        });

        it('returns result when present', async function () {
            axiosPostStub.resolves({ data: { result: TX_HASH } });
            const result = await connector.sendFunds(ADDRESS, AMOUNT);
            assert.strictEqual(result, TX_HASH);
        });

        it('returns null when result is missing', async function () {
            axiosPostStub.resolves({ data: {} });
            const result = await connector.sendFunds(ADDRESS, AMOUNT);
            assert.strictEqual(result, null);
        });
    });

    describe('setMiningTime', function () {
        it('sends the correct JSON-RPC payload', async function () {
            axiosPostStub.resolves({ data: { result: true } });

            await connector.setMiningTime(5000, 2000);

            const [url, data] = axiosPostStub.firstCall.args;
            assert.strictEqual(url, connector.url);
            assert.strictEqual(data.method, 'set_mining_time');
            assert.deepStrictEqual(data.params, { max_time: 5000, tx_added_time: 2000 });
        });

        it('returns result when present', async function () {
            axiosPostStub.resolves({ data: { result: 'ok' } });
            const result = await connector.setMiningTime(1000, 500);
            assert.strictEqual(result, 'ok');
        });

        it('returns null when result is missing', async function () {
            axiosPostStub.resolves({ data: {} });
            const result = await connector.setMiningTime(1000, 500);
            assert.strictEqual(result, null);
        });

        it('throws when the controller returns an {error} body instead of "ok" (uuid:24c35056)', async function () {
            // The regtest-miner controller reports rejected input as
            // {error: "..."} rather than throwing an HTTP error; that body is
            // truthy, so a plain truthiness check would previously read it as
            // success. The connector must inspect it and throw.
            axiosPostStub.resolves({ data: { result: { error: 'Mining times too small. Minimum is 1000ms.' } } });
            await assert.rejects(
                () => connector.setMiningTime(500, 500),
                /Mining times too small/
            );
        });
    });

    describe('setDefaultMiningTime', function () {
        it('sends the correct JSON-RPC payload with empty params', async function () {
            axiosPostStub.resolves({ data: { result: true } });

            await connector.setDefaultMiningTime();

            const [url, data] = axiosPostStub.firstCall.args;
            assert.strictEqual(url, connector.url);
            assert.strictEqual(data.method, 'set_default_mining_time');
            assert.deepStrictEqual(data.params, {});
        });

        it('returns result when present', async function () {
            axiosPostStub.resolves({ data: { result: 'default' } });
            const result = await connector.setDefaultMiningTime();
            assert.strictEqual(result, 'default');
        });

        it('returns null when result is missing', async function () {
            axiosPostStub.resolves({ data: {} });
            const result = await connector.setDefaultMiningTime();
            assert.strictEqual(result, null);
        });
    });
// setmocktime is a NODE-level control that the connector normally reaches
    // through the miner, because some installs do not publish the node RPC port.
    // Miner sidecars older than set_mock_time answer "Method not found", and a
    // long-lived venue routinely runs one chain's miner behind another's, which
    // would silently make every clock-driven drill family single-chain.
    describe('setMockTime node fallback', function () {

        it('uses the miner when it implements set_mock_time', async function () {
            axiosPostStub.resolves({ data: { result: 'ok' } });
            let nodeCalls = 0;
            global.nodeConnector = { _rpc: async () => { nodeCalls++; return null } };
            const result = await connector.setMockTime(1785126915);
            assert.strictEqual(result, 'ok');
            assert.strictEqual(nodeCalls, 0, 'a capable miner must not be bypassed');
            assert.strictEqual(axiosPostStub.firstCall.args[1].method, 'set_mock_time');
            delete global.nodeConnector;
        });

        it('falls back to the node RPC when the miner has no set_mock_time', async function () {
            axiosPostStub.resolves({ data: { error: 'Method not found - set_mock_time' } });
            const seen = [];
            global.nodeConnector = { _rpc: async (m, a) => { seen.push([m, a]); return null } };
            await connector.setMockTime('1785126915');
            assert.deepStrictEqual(seen, [['setmocktime', [1785126915]]],
                'the timestamp must reach the node as a NUMBER, whatever the caller passed');
            delete global.nodeConnector;
        });

        it('rethrows a miner REFUSAL rather than routing around it', async function () {
            // Mainnet refusal, bad input: the miner understood the call and said no.
            // Falling back here would drive a node the miner deliberately protected.
            axiosPostStub.resolves({ data: { error: 'refused: mainnet' } });
            let nodeCalls = 0;
            global.nodeConnector = { _rpc: async () => { nodeCalls++; return null } };
            await assert.rejects(() => connector.setMockTime(1), /refused: mainnet/);
            assert.strictEqual(nodeCalls, 0);
            delete global.nodeConnector;
        });

        it('keeps the miner error when no node connector is available', async function () {
            axiosPostStub.resolves({ data: { error: 'Method not found - set_mock_time' } });
            delete global.nodeConnector;
            await assert.rejects(() => connector.setMockTime(1), /Method not found/);
        });
    });
});
