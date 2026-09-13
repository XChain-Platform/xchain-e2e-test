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

describe('XChainIndexerConnector', function () {

    const URL  = 'localhost';
    const PORT = 4000;

    let connector;
    let axiosPostStub;

    beforeEach(function () {
        axiosPostStub = sinon.stub(axios, 'post');
        connector = new XChainIndexerConnector(URL, PORT);
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
    });

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

        it('returns false when response.data has no result key', async function () {
            axiosPostStub.resolves({ data: {} });
            const result = await connector.ping();
            assert.strictEqual(result, false);
        });

        it('returns false when axios throws (catches error internally)', async function () {
            axiosPostStub.rejects(new Error('ECONNREFUSED'));
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

    // A gated method is refused with a non-2xx status whose body is still a
    // JSON-RPC error envelope, and axios rejects it. call() must tell that apart
    // from a dead socket: rollcallHelper.assertGatedReadsReachable only prints
    // its INDEXER_API_KEY sentence for a throw, so a null here erases it.
    describe('service refusals versus transport failures', function () {

        function refusal() {
            return Object.assign(new Error('Request failed with status code 401'), {
                response: {
                    status: 401, statusText: 'Unauthorized',
                    data: { jsonrpc: '2.0', id: 1,
                        error: { code: -32001, message: 'Unauthorized: this method requires INDEXER_API_KEY' } }
                }
            });
        }

        it('call() throws the service message on a gated 401', async function () {
            axiosPostStub.rejects(refusal());
            await assert.rejects(
                () => connector.call('getcapabilityvalidators', { capability: 'oracle_publish', block_index: 100 }),
                /Unauthorized: this method requires INDEXER_API_KEY/);
        });

        it('call() names the method it was refused', async function () {
            axiosPostStub.rejects(refusal());
            await assert.rejects(
                () => connector.call('getcapabilityvalidators', {}),
                /getcapabilityvalidators/);
        });

        it('call() still returns null when nothing answered the socket', async function () {
            axiosPostStub.rejects(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
            assert.strictEqual(await connector.call('getcapabilityvalidators', {}), null);
        });

        it('call() falls back to an HTTP status when the body carries no RPC error', async function () {
            axiosPostStub.rejects(Object.assign(new Error('Request failed with status code 502'), {
                response: { status: 502, statusText: 'Bad Gateway', data: '<html>' }
            }));
            await assert.rejects(() => connector.call('health', {}), /HTTP 502 Bad Gateway/);
        });

        it('health() keeps its null sentinel so waitForIndexedBlock can ride out a refusal', async function () {
            const warn = sinon.stub(console, 'warn');
            try {
                axiosPostStub.rejects(refusal());
                assert.strictEqual(await connector.health(), null);
                assert.strictEqual(warn.callCount, 1);
                assert.match(warn.firstCall.args[0], /refused health: Unauthorized/);
            } finally { warn.restore(); }
        });

        it('ping() keeps returning false and names the refusal', async function () {
            const warn = sinon.stub(console, 'warn');
            try {
                axiosPostStub.rejects(refusal());
                assert.strictEqual(await connector.ping(), false);
                assert.match(warn.firstCall.args[0], /refused ping: Unauthorized/);
            } finally { warn.restore(); }
        });
    });
});
