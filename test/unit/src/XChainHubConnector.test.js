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

const XChainHubConnector = require('../../../src/XChainHubConnector');

// Build an Axios-style error for a non-2xx response that still carries a valid
// JSON-RPC body — e.g. the hub's HTTP 503 "degraded" health response when its DB
// pool is down. Axios attaches the full response to the thrown error as err.response.
function degraded503Error(body) {
    const err = new Error('Request failed with status code 503');
    err.response = {
        status: 503,
        data: { jsonrpc: '2.0', id: 1, result: body || { status: 'degraded', db: false } }
    };
    return err;
}

describe('XChainHubConnector', function () {

    let axiosPostStub;

    beforeEach(function () {
        axiosPostStub = sinon.stub(axios, 'post');
    });

    afterEach(function () {
        sinon.restore();
        // Clean any env vars set during tests
        delete process.env.HUB_VALIDATORS;
        delete process.env.HUB_URL;
        delete process.env.HUB_API_HOST;
        delete process.env.HUB_PORT;
    });

    // ── constructor ──────────────────────────────────────────────────────

    describe('constructor', function () {
        it('stores an array of endpoints directly in this.urls', function () {
            const endpoints = ['http://hub1:10000', 'http://hub2:10000'];
            const conn = new XChainHubConnector(endpoints);
            assert.deepStrictEqual(conn.urls, endpoints);
        });

        it('wraps a single string host+port into an array: http://{host}:{port}', function () {
            const conn = new XChainHubConnector('localhost', 10000);
            assert.deepStrictEqual(conn.urls, ['http://localhost:10000']);
        });

        it('wraps a string endpoint as-is when port is provided', function () {
            const conn = new XChainHubConnector('myhost', 9999);
            assert.strictEqual(conn.urls[0], 'http://myhost:9999');
        });
    });

    // ── _call ─────────────────────────────────────────────────────────────

    describe('_call', function () {
        it('returns result from the first reachable endpoint', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000', 'http://hub2:10000']);
            axiosPostStub.resolves({ data: { result: { key: 'value' } } });

            const result = await conn._call({ method: 'test' });
            assert.deepStrictEqual(result, { key: 'value' });
            // Only the first URL should have been tried
            assert.strictEqual(axiosPostStub.callCount, 1);
        });

        it('tries the next endpoint when the first one throws', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000', 'http://hub2:10000']);
            axiosPostStub
                .onFirstCall().rejects(new Error('connection refused'))
                .onSecondCall().resolves({ data: { result: 'ok' } });

            const result = await conn._call({ method: 'test' });
            assert.strictEqual(result, 'ok');
            assert.strictEqual(axiosPostStub.callCount, 2);
        });

        it('returns null when all endpoints fail', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000', 'http://hub2:10000']);
            axiosPostStub.rejects(new Error('connection refused'));

            const result = await conn._call({ method: 'test' });
            assert.strictEqual(result, null);
        });

        it('returns null when response has no result field', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000']);
            // result === undefined → `result !== undefined` is false → skip
            axiosPostStub.resolves({ data: {} });

            const result = await conn._call({ method: 'test' });
            assert.strictEqual(result, null);
        });

        it('returns the result even when it is falsy (0, false, "")', async function () {
            // The source checks `response.data.result !== undefined` — falsy truths count
            const conn = new XChainHubConnector(['http://hub1:10000']);
            axiosPostStub.resolves({ data: { result: false } });

            const result = await conn._call({ method: 'test' });
            assert.strictEqual(result, false);
        });

        it('surfaces the JSON-RPC body of a 503 "degraded" response instead of discarding it', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000']);
            axiosPostStub.rejects(degraded503Error());

            const result = await conn._call({ method: 'ping' });
            // The reachable-but-degraded body is returned, not null.
            assert.deepStrictEqual(result, { status: 'degraded', db: false });
        });

        it('prefers a healthy endpoint over a degraded one when both are present', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000', 'http://hub2:10000']);
            axiosPostStub
                .onFirstCall().rejects(degraded503Error())
                .onSecondCall().resolves({ data: { result: 'pong' } });

            const result = await conn._call({ method: 'ping' });
            assert.strictEqual(result, 'pong');
            assert.strictEqual(axiosPostStub.callCount, 2);
        });
    });

    // ── ping ─────────────────────────────────────────────────────────────

    describe('ping', function () {
        it('returns true when _call returns a non-null value', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000']);
            sinon.stub(conn, '_call').resolves('pong');

            const result = await conn.ping();
            assert.strictEqual(result, true);
        });

        it('returns false when _call returns null', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000']);
            sinon.stub(conn, '_call').resolves(null);

            const result = await conn.ping();
            assert.strictEqual(result, false);
        });

        it('returns true (reachable) for a degraded hub rather than masking it as down', async function () {
            // A live hub with a dead DB pool must NOT read the same as a crashed one.
            const conn = new XChainHubConnector(['http://hub1:10000']);
            sinon.stub(conn, '_call').resolves({ status: 'degraded', db: false });

            const result = await conn.ping();
            assert.strictEqual(result, true);
        });

        it('sends JSON-RPC ping payload', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000']);
            const callStub = sinon.stub(conn, '_call').resolves('pong');

            await conn.ping();

            const [data] = callStub.firstCall.args;
            assert.strictEqual(data.jsonrpc, '2.0');
            assert.strictEqual(data.method, 'ping');
            assert.strictEqual(data.id, 1);
        });
    });

    // ── getAllConfig ──────────────────────────────────────────────────────

    describe('getAllConfig', function () {
        it('calls _call with method getallconfigs and empty params array', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000']);
            const callStub = sinon.stub(conn, '_call').resolves({ bitcoin: {} });

            await conn.getAllConfig();

            const [data] = callStub.firstCall.args;
            assert.strictEqual(data.method, 'getallconfigs');
            assert.deepStrictEqual(data.params, []);
        });

        it('returns whatever _call returns', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000']);
            const configs = { bitcoin: { regtest: {} } };
            sinon.stub(conn, '_call').resolves(configs);

            const result = await conn.getAllConfig();
            assert.deepStrictEqual(result, configs);
        });

        it('unwraps the { configs, seq, watermark } envelope to the flat tree', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000']);
            const configs = { bitcoin: { regtest: { node: { server_port: 18443 } } } };
            sinon.stub(conn, '_call').resolves({ configs, seq: 7, watermark: 7 });

            const result = await conn.getAllConfig();
            assert.deepStrictEqual(result, configs);
        });

        it('returns null when _call returns null', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000']);
            sinon.stub(conn, '_call').resolves(null);

            const result = await conn.getAllConfig();
            assert.strictEqual(result, null);
        });

        it('returns null (not the degraded body) when the hub reports degraded', async function () {
            // A {status:"degraded"} body is not a config tree — it must not be
            // returned as one, or the caller would index into it as config.
            const conn = new XChainHubConnector(['http://hub1:10000']);
            sinon.stub(conn, '_call').resolves({ status: 'degraded', db: false });

            const result = await conn.getAllConfig();
            assert.strictEqual(result, null);
        });

        it('returns null when the hub returns a {error} config body', async function () {
            const conn = new XChainHubConnector(['http://hub1:10000']);
            sinon.stub(conn, '_call').resolves({ error: 'there was an error trying to get all configs' });

            const result = await conn.getAllConfig();
            assert.strictEqual(result, null);
        });
    });

    // ── parseEndpoints ────────────────────────────────────────────────────

    describe('parseEndpoints (static)', function () {
        it('splits HUB_VALIDATORS by comma and returns an array of URLs', function () {
            process.env.HUB_VALIDATORS = 'http://hub1:10000,http://hub2:10000';
            const result = XChainHubConnector.parseEndpoints();
            assert.deepStrictEqual(result, ['http://hub1:10000', 'http://hub2:10000']);
        });

        it('trims whitespace from each entry in HUB_VALIDATORS', function () {
            process.env.HUB_VALIDATORS = ' hub1:10000 , hub2:10000 ';
            const result = XChainHubConnector.parseEndpoints();
            assert.deepStrictEqual(result, ['http://hub1:10000', 'http://hub2:10000']);
        });

        it('does not prepend http:// when entry already starts with http', function () {
            process.env.HUB_VALIDATORS = 'http://hub1:10000';
            const result = XChainHubConnector.parseEndpoints();
            assert.strictEqual(result[0], 'http://hub1:10000');
        });

        it('filters out empty entries in HUB_VALIDATORS', function () {
            process.env.HUB_VALIDATORS = 'hub1:10000,,hub2:10000';
            const result = XChainHubConnector.parseEndpoints();
            assert.strictEqual(result.length, 2);
        });

        it('falls back to HUB_URL + HUB_PORT when HUB_VALIDATORS is absent', function () {
            process.env.HUB_URL  = 'myhubhost';
            process.env.HUB_PORT = '20000';
            const result = XChainHubConnector.parseEndpoints();
            assert.deepStrictEqual(result, ['http://myhubhost:20000']);
        });

        it('falls back to HUB_API_HOST when HUB_URL is absent', function () {
            process.env.HUB_API_HOST = 'apihubhost';
            process.env.HUB_PORT     = '30000';
            const result = XChainHubConnector.parseEndpoints();
            assert.deepStrictEqual(result, ['http://apihubhost:30000']);
        });

        it('defaults to localhost:10000 when no env vars are set', function () {
            const result = XChainHubConnector.parseEndpoints();
            assert.deepStrictEqual(result, ['http://localhost:10000']);
        });
    });
});
