'use strict';

const assert = require('assert');
const sinon  = require('sinon');

// ── cross-fetch injection ──────────────────────────────────────────────────
// XChainUtxoTrackerConnector captures `fetch` at require-time just like
// BlockchainConnector, so we need the same cache-injection pattern.
// We reuse the same crossFetchCacheKey since it resolves to the same path.

let fetchStub;
let UtxoTracker;
let crossFetchCacheKey;

before(function () {
    fetchStub = sinon.stub();
    crossFetchCacheKey = require.resolve('cross-fetch');

    require.cache[crossFetchCacheKey] = {
        id: crossFetchCacheKey,
        filename: crossFetchCacheKey,
        loaded: true,
        exports: fetchStub
    };

    UtxoTracker = require('../../../src/XChainUtxoTrackerConnector');
});

after(function () {
    delete require.cache[crossFetchCacheKey];
    delete require.cache[require.resolve('../../../src/XChainUtxoTrackerConnector')];
});

// ── helpers ───────────────────────────────────────────────────────────────

function makeOkResponse(body) {
    return {
        ok: true,
        status: 200,
        json: async () => body
    };
}

function makeErrorResponse(status) {
    return {
        ok: false,
        status,
        json: async () => ({})
    };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('XChainUtxoTrackerConnector (UtxoTracker)', function () {

    const URL  = 'localhost';
    const PORT = 3000;

    let tracker;

    beforeEach(function () {
        fetchStub.reset();
        tracker = new UtxoTracker(URL, PORT);
    });

    // ── constructor ──────────────────────────────────────────────────────

    describe('constructor', function () {
        it('builds the URL as http://{url}:{port}', function () {
            assert.strictEqual(tracker.url, `http://${URL}:${PORT}`);
        });

        it('stores port', function () {
            assert.strictEqual(tracker.port, PORT);
        });
    });

    // ── ping ─────────────────────────────────────────────────────────────

    describe('ping', function () {
        it('returns true when responseData.result is truthy', async function () {
            fetchStub.resolves(makeOkResponse({ result: 'pong' }));
            const result = await tracker.ping();
            assert.strictEqual(result, true);
        });

        it('returns false when responseData.result is falsy', async function () {
            fetchStub.resolves(makeOkResponse({ result: null }));
            const result = await tracker.ping();
            assert.strictEqual(result, false);
        });

        it('returns false when result key is absent', async function () {
            fetchStub.resolves(makeOkResponse({}));
            const result = await tracker.ping();
            assert.strictEqual(result, false);
        });

        it('throws when HTTP response is not ok', async function () {
            fetchStub.resolves(makeErrorResponse(503));
            await assert.rejects(() => tracker.ping(), /HTTP error/);
        });

        it('sends a POST with Content-Type application/json to the tracker URL', async function () {
            fetchStub.resolves(makeOkResponse({ result: 'pong' }));
            await tracker.ping();

            const [url, opts] = fetchStub.firstCall.args;
            assert.strictEqual(url, tracker.url);
            assert.strictEqual(opts.method, 'POST');
            assert.strictEqual(opts.headers['Content-Type'], 'application/json');
        });
    });

    // ── getUtxosFromAddress ───────────────────────────────────────────────

    describe('getUtxosFromAddress', function () {
        const ADDRESS = 'bcrt1qtest';
        const fakeResult = { utxos: [{ txid: 'abc', vout: 0, value: 5000 }] };

        it('sends get_utxos with {address} in params', async function () {
            fetchStub.resolves(makeOkResponse({ result: fakeResult }));

            await tracker.getUtxosFromAddress(ADDRESS);

            const [url, opts] = fetchStub.firstCall.args;
            assert.strictEqual(url, tracker.url);

            const body = JSON.parse(opts.body);
            assert.strictEqual(body.method, 'get_utxos');
            assert.deepStrictEqual(body.params, { address: ADDRESS });
        });

        it('returns result on success', async function () {
            fetchStub.resolves(makeOkResponse({ result: fakeResult }));
            const result = await tracker.getUtxosFromAddress(ADDRESS);
            assert.deepStrictEqual(result, fakeResult);
        });

        it('throws when HTTP response is not ok', async function () {
            fetchStub.resolves(makeErrorResponse(500));
            await assert.rejects(
                () => tracker.getUtxosFromAddress(ADDRESS),
                /HTTP error/
            );
        });

        it('throws when result is missing', async function () {
            fetchStub.resolves(makeOkResponse({ result: null }));
            await assert.rejects(
                () => tracker.getUtxosFromAddress(ADDRESS),
                /Error getting utxos/
            );
        });
    });

    // ── waitForUtxos ──────────────────────────────────────────────────────

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
