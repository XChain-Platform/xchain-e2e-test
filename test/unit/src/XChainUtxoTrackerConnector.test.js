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

const UtxoTracker = require('../../../src/XChainUtxoTrackerConnector');

function makeResponse(body) {
    return { status: 200, data: body };
}

function makeHttpError(status) {
    const err = new Error(`Request failed with status code ${status}`);
    err.response = { status, statusText: 'Error', data: {} };
    return err;
}

describe('XChainUtxoTrackerConnector (UtxoTracker)', function () {

    const URL  = 'localhost';
    const PORT = 3000;

    let tracker;
    let axiosPostStub;

    beforeEach(function () {
        axiosPostStub = sinon.stub(axios, 'post');
        tracker = new UtxoTracker(URL, PORT);
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('constructor', function () {
        it('builds the URL as http://{url}:{port}', function () {
            assert.strictEqual(tracker.url, `http://${URL}:${PORT}`);
        });

        it('stores port', function () {
            assert.strictEqual(tracker.port, PORT);
        });
    });

    describe('ping', function () {
        it('returns true when responseData.result is truthy', async function () {
            axiosPostStub.resolves(makeResponse({ result: 'pong' }));
            const result = await tracker.ping();
            assert.strictEqual(result, true);
        });

        it('returns false when responseData.result is falsy', async function () {
            axiosPostStub.resolves(makeResponse({ result: null }));
            const result = await tracker.ping();
            assert.strictEqual(result, false);
        });

        it('returns false when result key is absent', async function () {
            axiosPostStub.resolves(makeResponse({}));
            const result = await tracker.ping();
            assert.strictEqual(result, false);
        });

        it('returns false when the HTTP response is an error status', async function () {
            axiosPostStub.rejects(makeHttpError(503));
            const result = await tracker.ping();
            assert.strictEqual(result, false);
        });

        it('returns false when axios rejects', async function () {
            axiosPostStub.rejects(new Error('network down'));
            const result = await tracker.ping();
            assert.strictEqual(result, false);
        });

        it('sends a POST with Content-Type application/json to the tracker URL', async function () {
            axiosPostStub.resolves(makeResponse({ result: 'pong' }));
            await tracker.ping();

            const [url, , opts] = axiosPostStub.firstCall.args;
            assert.strictEqual(url, tracker.url);
            assert.strictEqual(opts.headers['Content-Type'], 'application/json');
        });
    });

    describe('getUtxosFromAddress', function () {
        const ADDRESS = 'bcrt1qtest';
        const fakeResult = { utxos: [{ txid: 'abc', vout: 0, value: 5000 }] };

        it('sends get_utxos with {address} in params', async function () {
            axiosPostStub.resolves(makeResponse({ result: fakeResult }));

            await tracker.getUtxosFromAddress(ADDRESS);

            const [url, data] = axiosPostStub.firstCall.args;
            assert.strictEqual(url, tracker.url);
            assert.strictEqual(data.method, 'get_utxos');
            assert.deepStrictEqual(data.params, { address: ADDRESS });
        });

        it('returns result on success', async function () {
            axiosPostStub.resolves(makeResponse({ result: fakeResult }));
            const result = await tracker.getUtxosFromAddress(ADDRESS);
            assert.deepStrictEqual(result, fakeResult);
        });

        it('throws when the HTTP request fails (axios rejects on non-2xx)', async function () {
            axiosPostStub.rejects(makeHttpError(500));
            await assert.rejects(
                () => tracker.getUtxosFromAddress(ADDRESS),
                /500/
            );
        });

        it('throws when result is missing', async function () {
            axiosPostStub.resolves(makeResponse({ result: null }));
            await assert.rejects(
                () => tracker.getUtxosFromAddress(ADDRESS),
                /Error getting utxos/
            );
        });
    });

    // The barrier used to discard a failed nudge mine outright
    // (`catch (e) {}`), so a stack that never settled came back as a bare
    // ready=false with no cause attached and the hooks that only awaited it
    // let the unsettled state leak into the next test.
    describe('quiesce', function () {
        it('reports the settled status with a zero nudge-failure tally', async function () {
            sinon.stub(tracker, 'getQuiescentStatus').resolves({ ready: true, mempool_size: 0 });
            sinon.stub(tracker, 'sleep').resolves();

            const status = await tracker.quiesce({ timeoutMs: 1000, pollMs: 1 });
            assert.strictEqual(status.ready, true);
            assert.strictEqual(status.mineErrors, 0);
        });

        it('surfaces a failed nudge mine instead of swallowing it', async function () {
            sinon.stub(tracker, 'getQuiescentStatus').resolves({ ready: false, mempool_size: 3 });
            sinon.stub(tracker, 'sleep').resolves();
            const warn = sinon.stub(console, 'warn');
            const regtestMiner = { generateBlocks: sinon.stub().rejects(new Error('miner down')) };

            const status = await tracker.quiesce({ timeoutMs: 30, pollMs: 1, regtestMiner });

            assert.strictEqual(status.ready, false);
            assert.ok(status.mineErrors > 0, 'expected the failed nudge to be counted');
            assert.strictEqual(status.lastMineError, 'miner down');
            assert.ok(warn.called, 'expected the failed nudge to be warned about');
        });

        it('still returns the unready status rather than throwing, for retry-loop callers', async function () {
            sinon.stub(tracker, 'getQuiescentStatus').resolves({ ready: false, mempool_size: 0 });
            sinon.stub(tracker, 'sleep').resolves();

            const status = await tracker.quiesce({ timeoutMs: 20, pollMs: 1 });
            assert.strictEqual(status.ready, false);
        });

        it('leaves a null no-response status null', async function () {
            sinon.stub(tracker, 'getQuiescentStatus').resolves(null);
            sinon.stub(tracker, 'sleep').resolves();

            assert.strictEqual(await tracker.quiesce({ timeoutMs: 20, pollMs: 1 }), null);
        });
    });

    describe('waitForUtxos', function () {
        const ADDRESS = 'bcrt1qwait';

        it('returns true when getUtxosFromAddress returns utxos immediately', async function () {
            sinon.stub(tracker, 'getUtxosFromAddress').resolves({ utxos: [{ txid: 'abc' }] });
            sinon.stub(tracker, 'sleep').resolves();

            const result = await tracker.waitForUtxos(ADDRESS);
            assert.strictEqual(result, true);
        });

        it('returns false after timeout when address always has no utxos', async function () {
            sinon.stub(tracker, 'getUtxosFromAddress').resolves({ utxos: [] });
            sinon.stub(tracker, 'sleep').resolves();

            const now = Date.now();
            const dateStub = sinon.stub(Date, 'now');
            dateStub.onFirstCall().returns(now);
            dateStub.returns(now + 99999);

            try {
                const result = await tracker.waitForUtxos(ADDRESS, 60000);
                assert.strictEqual(result, false);
            } finally {
                dateStub.restore();
            }
        });

        it('returns false after timeout when getUtxosFromAddress always throws', async function () {
            sinon.stub(tracker, 'getUtxosFromAddress').rejects(new Error('not found'));
            sinon.stub(tracker, 'sleep').resolves();

            const now = Date.now();
            const dateStub = sinon.stub(Date, 'now');
            dateStub.onFirstCall().returns(now);
            dateStub.returns(now + 99999);

            try {
                const result = await tracker.waitForUtxos(ADDRESS, 60000);
                assert.strictEqual(result, false);
            } finally {
                dateStub.restore();
            }
        });
    });
});
