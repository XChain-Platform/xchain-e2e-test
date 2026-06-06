'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
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

    // ── constructor ──────────────────────────────────────────────────────

    describe('constructor', function () {
        it('builds the URL as http://{url}:{port}', function () {
            assert.strictEqual(connector.url, `http://${URL}:${PORT}`);
        });

        it('stores port', function () {
            assert.strictEqual(connector.port, PORT);
        });
    });

    // ── ping ─────────────────────────────────────────────────────────────

    describe('ping', function () {
        it('returns true when response.data.result is truthy', async function () {
            axiosPostStub.resolves({ data: { result: 'pong' } });
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

    // ── sendFunds ─────────────────────────────────────────────────────────

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

    // ── setMiningTime ─────────────────────────────────────────────────────

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
    });

    // ── setDefaultMiningTime ──────────────────────────────────────────────

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
});
