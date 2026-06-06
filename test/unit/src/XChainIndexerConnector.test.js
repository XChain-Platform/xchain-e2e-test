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
});
