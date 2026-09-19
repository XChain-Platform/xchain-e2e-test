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

const XChainExplorerConnector = require('../../../src/XChainExplorerConnector');

const URL  = 'localhost';
const PORT = 18080;

let connector;
let axiosPostStub;
let axiosGetStub;

function setupConnector() {
    axiosPostStub = sinon.stub(axios, 'post');
    axiosGetStub  = sinon.stub(axios, 'get');
    connector = new XChainExplorerConnector(URL, PORT);
}

function teardownConnector() {
    sinon.restore();
}

describe('XChainExplorerConnector', function () {
    beforeEach(setupConnector);
    afterEach(teardownConnector);
    describe('constructor', function () {
        it('builds the URL as http://{url}:{port}', function () {
            assert.strictEqual(connector.url, `http://${URL}:${PORT}`);
        });
    });
});

describe('XChainExplorerConnector', function () {
    beforeEach(setupConnector);
    afterEach(teardownConnector);
    describe('ping', function () {
        it('returns true when response.data.result is present', async function () {
            axiosPostStub.resolves({ data: { result: 'pong' } });
            assert.strictEqual(await connector.ping(), true);
        });

        it('returns false when axios throws', async function () {
            axiosPostStub.rejects(new Error('connection refused'));
            assert.strictEqual(await connector.ping(), false);
        });

        // Without a per-request cap, an explorer that accepts the socket and
        // never answers (the "503 with zero DB pools" venue left with no pool
        // to answer FROM) left this pending forever. initialCheck.test.js
        // requires this ping before any action test runs, and the suite runs
        // under `mocha --timeout 0`, so nothing else in this stack would ever
        // time the call out: a stuck explorer silently stalled the whole CI
        // job (xchain-node run 35440776385, LTC/DOGE legs, 2026-09-19) instead
        // of failing it fast the way the known "answers 503" shape does.
        it('bounds the readiness probe with a request timeout', async function () {
            axiosPostStub.resolves({ data: { result: 'pong' } });
            await connector.ping();
            const cfg = axiosPostStub.firstCall.args[2];
            assert.strictEqual(typeof cfg.timeout, 'number');
            assert.ok(cfg.timeout > 0);
        });
    });
});

describe('XChainExplorerConnector', function () {
    beforeEach(setupConnector);
    afterEach(teardownConnector);
    describe('getFileRaw', function () {
        it('returns status, headers and body from the response', async function () {
            axiosGetStub.resolves({
                status: 200,
                headers: { 'x-xchain-stored-form': 'raw' },
                data: Buffer.from('abc'),
            });
            const result = await connector.getFileRaw('btc', 5);
            assert.strictEqual(result.status, 200);
            assert.deepStrictEqual(result.headers, { 'x-xchain-stored-form': 'raw' });
            assert.ok(result.body.equals(Buffer.from('abc')));
        });

        // waitForServedFile (envelopeHelper.js) polls this against its own
        // bounded deadline; that deadline is defeated if a single GET inside
        // the loop can itself hang past it with no cap of its own.
        it('bounds the file fetch with a request timeout', async function () {
            axiosGetStub.resolves({ status: 200, headers: {}, data: Buffer.alloc(0) });
            await connector.getFileRaw('btc', 5);
            const cfg = axiosGetStub.firstCall.args[1];
            assert.strictEqual(typeof cfg.timeout, 'number');
            assert.ok(cfg.timeout > 0);
        });
    });
});
