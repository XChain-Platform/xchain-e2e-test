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

const XChainIndexerConnector = require('../../../src/XChainIndexerConnector');

// Each registrar reads the connector and axios.post stub from ctx, which the
// outer beforeEach refills for every test.
function registerConstructorTests(ctx) {
    it('builds the URL as http://{url}:{port}', function () {
        assert.strictEqual(ctx.connector.url, `http://${URL}:${PORT}`);
    });

    it('stores port', function () {
        assert.strictEqual(ctx.connector.port, PORT);
    });
}

function registerPingTests(ctx) {
    it('returns true when response.data.result is truthy', async function () {
        ctx.post.resolves({ data: { result: 'pong' } });
        const result = await ctx.connector.ping();
        assert.strictEqual(result, true);
    });

    it('returns false when response.data.result is falsy', async function () {
        ctx.post.resolves({ data: { result: null } });
        const result = await ctx.connector.ping();
        assert.strictEqual(result, false);
    });

    it('returns false when response.data has no result key', async function () {
        ctx.post.resolves({ data: {} });
        const result = await ctx.connector.ping();
        assert.strictEqual(result, false);
    });

    it('returns false when axios throws (catches error internally)', async function () {
        ctx.post.rejects(new Error('ECONNREFUSED'));
        const result = await ctx.connector.ping();
        assert.strictEqual(result, false);
    });

    it('sends JSON-RPC ping payload to the correct URL', async function () {
        ctx.post.resolves({ data: { result: 'pong' } });
        await ctx.connector.ping();

        const [url, data] = ctx.post.firstCall.args;
        assert.strictEqual(url, ctx.connector.url);
        assert.strictEqual(data.jsonrpc, '2.0');
        assert.strictEqual(data.method, 'ping');
        assert.strictEqual(data.id, 1);
    });
}

function refusal() {
    return Object.assign(new Error('Request failed with status code 401'), {
        response: {
            status: 401, statusText: 'Unauthorized',
            data: { jsonrpc: '2.0', id: 1,
                error: { code: -32001, message: 'Unauthorized: this method requires INDEXER_API_KEY' } }
        }
    });
}

function registerCallRefusalTests(ctx) {
    it('call() throws the service message on a gated 401', async function () {
        ctx.post.rejects(refusal());
        await assert.rejects(
            () => ctx.connector.call('getcapabilityvalidators', { capability: 'oracle_publish', block_index: 100 }),
            /Unauthorized: this method requires INDEXER_API_KEY/);
    });

    it('call() names the method it was refused', async function () {
        ctx.post.rejects(refusal());
        await assert.rejects(
            () => ctx.connector.call('getcapabilityvalidators', {}),
            /getcapabilityvalidators/);
    });

    it('call() still returns null when nothing answered the socket', async function () {
        ctx.post.rejects(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
        assert.strictEqual(await ctx.connector.call('getcapabilityvalidators', {}), null);
    });

    it('call() falls back to an HTTP status when the body carries no RPC error', async function () {
        ctx.post.rejects(Object.assign(new Error('Request failed with status code 502'), {
            response: { status: 502, statusText: 'Bad Gateway', data: '<html>' }
        }));
        await assert.rejects(() => ctx.connector.call('health', {}), /HTTP 502 Bad Gateway/);
    });
}

function registerProbeRefusalTests(ctx) {
    it('health() keeps its null sentinel so waitForIndexedBlock can ride out a refusal', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            ctx.post.rejects(refusal());
            assert.strictEqual(await ctx.connector.health(), null);
            assert.strictEqual(warn.callCount, 1);
            assert.match(warn.firstCall.args[0], /refused health: Unauthorized/);
        } finally { warn.restore(); }
    });

    it('ping() keeps returning false and names the refusal', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            ctx.post.rejects(refusal());
            assert.strictEqual(await ctx.connector.ping(), false);
            assert.match(warn.firstCall.args[0], /refused ping: Unauthorized/);
        } finally { warn.restore(); }
    });
}

function answer(extra) {
    return { data: { result: Object.assign(
        { capability: 'oracle_publish', block_index: 10, count: 1, validators: [{ pubkey: 'p' }] }, extra) } };
}

function registerTruncationTests(ctx) {
    it('throws when the indexer marks the set truncated', async function () {
        ctx.post.resolves(answer({ truncated: true }));
        await assert.rejects(() => ctx.connector.getCapabilityValidators('oracle_publish', 10), /TRUNCATED/);
    });

    it('returns a set the indexer marks complete', async function () {
        ctx.post.resolves(answer({ truncated: false }));
        const res = await ctx.connector.getCapabilityValidators('oracle_publish', 10);
        assert.strictEqual(res.truncated, false);
        assert.strictEqual(res.count, 1);
    });

    it('returns a set from an older indexer that omits the flag', async function () {
        ctx.post.resolves(answer({}));
        const res = await ctx.connector.getCapabilityValidators('oracle_publish', 10);
        assert.strictEqual(res.count, 1);
        assert.ok(!('truncated' in res));
    });

    it('leaves raw call() able to read a truncated set', async function () {
        ctx.post.resolves(answer({ truncated: true }));
        const res = await ctx.connector.call('getcapabilityvalidators', { capability: 'oracle_publish', block_index: 10 });
        assert.strictEqual(res.truncated, true);
    });
}

const URL  = 'localhost';
const PORT = 4000;

describe('XChainIndexerConnector', function () {

    const ctx = {};

    beforeEach(function () {
        ctx.post = sinon.stub(axios, 'post');
        ctx.connector = new XChainIndexerConnector(URL, PORT);
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('constructor', function () { registerConstructorTests(ctx); });

    describe('ping', function () { registerPingTests(ctx); });

    // A gated method is refused with a non-2xx status whose body is still a
    // JSON-RPC error envelope, and axios rejects it. call() must tell that apart
    // from a dead socket: rollcallHelper.assertGatedReadsReachable only prints
    // its INDEXER_API_KEY sentence for a throw, so a null here erases it.
    describe('service refusals versus transport failures', function () {
        registerCallRefusalTests(ctx);
        registerProbeRefusalTests(ctx);
    });

    // The indexer flags a set cut at VALIDATOR_QUERY_LIMIT; a count or membership
    // assertion on it would read as a product regression, so the wrapper refuses it.
    describe('getCapabilityValidators truncation', function () { registerTruncationTests(ctx); });
});

// waitForIndexedBlock checks its deadline only between health calls, so the probes
// carry their own request timeout; call() is general RPC and stays unbounded.
describe('XChainIndexerConnector probe timeouts', function () {
    let connector;
    let post;
    beforeEach(function () {
        post = sinon.stub(axios, 'post');
        connector = new XChainIndexerConnector('localhost', 4000);
    });
    afterEach(function () { sinon.restore(); });

    it('bounds ping and health, and a timed-out probe keeps its sentinel', async function () {
        post.resolves({ data: { result: { ok: true } } });
        await connector.ping();
        await connector.health();
        assert.ok(post.firstCall.args[2].timeout > 0, 'ping posted with no timeout');
        assert.ok(post.secondCall.args[2].timeout > 0, 'health posted with no timeout');
        post.rejects(Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }));
        const info = sinon.stub(console, 'info');
        try {
            assert.strictEqual(await connector.ping(), false);
            assert.strictEqual(await connector.health(), null);
        } finally { info.restore(); }
    });
});
