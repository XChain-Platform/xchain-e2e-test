'use strict';

const assert = require('assert');
const sinon = require('sinon');
const axios = require('axios');

// ── axios injection ─────────────────────────────────────────────────────────
// BlockchainConnector issues its JSON-RPC calls via axios.post. We stub
// axios.post directly (the connector resolves it at call time off the shared
// axios object), matching the pattern used by the other connector unit tests.

const BlockchainConnector = require('../../../src/BlockchainConnector');

// ── helpers ───────────────────────────────────────────────────────────────

function makeResponse(body) {
    return { status: 200, data: body };
}

// Axios rejects on non-2xx with an Error carrying a `.response`.
function makeHttpError(status, data = {}) {
    const err = new Error(`Request failed with status code ${status}`);
    err.response = { status, statusText: 'Error', data };
    return err;
}

function expectedAuth(user, pass) {
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('BlockchainConnector', function () {

    const URL  = 'localhost';
    const PORT = 8332;
    const USER = 'rpcuser';
    const PASS = 'rpcpass';

    let connector;
    let axiosPostStub;

    beforeEach(function () {
        axiosPostStub = sinon.stub(axios, 'post');
        connector = new BlockchainConnector(URL, PORT, USER, PASS);
    });

    afterEach(function () {
        sinon.restore();
    });

    // ── constructor ──────────────────────────────────────────────────────

    describe('constructor', function () {
        it('builds the URL as http://{url}:{port}', function () {
            assert.strictEqual(connector.url, `http://${URL}:${PORT}`);
        });

        it('stores rpcUser and rpcPassword', function () {
            assert.strictEqual(connector.rpcUser, USER);
            assert.strictEqual(connector.rpcPassword, PASS);
        });
    });

    // ── getNetworkInfo ────────────────────────────────────────────────────

    describe('getNetworkInfo', function () {
        it('sends the correct JSON-RPC payload with method getnetworkinfo', async function () {
            const fakeResult = { version: 210000 };
            axiosPostStub.resolves(makeResponse({ result: fakeResult }));

            await connector.getNetworkInfo();

            const [url, data] = axiosPostStub.firstCall.args;
            assert.strictEqual(url, connector.url);
            assert.strictEqual(data.jsonrpc, '2.0');
            assert.strictEqual(data.method, 'getnetworkinfo');
            assert.strictEqual(data.id, 1);
        });

        it('sends a valid Basic auth header', async function () {
            axiosPostStub.resolves(makeResponse({ result: { version: 1 } }));
            await connector.getNetworkInfo();

            const opts = axiosPostStub.firstCall.args[2];
            assert.strictEqual(opts.headers['Authorization'], expectedAuth(USER, PASS));
        });

        it('returns the result on success', async function () {
            const fakeResult = { subversion: '/Satoshi:0.21/' };
            axiosPostStub.resolves(makeResponse({ result: fakeResult }));

            const result = await connector.getNetworkInfo();
            assert.deepStrictEqual(result, fakeResult);
        });

        it('throws when the HTTP request fails (axios rejects on non-2xx)', async function () {
            axiosPostStub.rejects(makeHttpError(500));
            await assert.rejects(
                () => connector.getNetworkInfo(),
                /Error in network request/
            );
        });

        it('throws when response has no result', async function () {
            axiosPostStub.resolves(makeResponse({ result: null }));
            await assert.rejects(
                () => connector.getNetworkInfo(),
                /Error/
            );
        });
    });

    // ── getTransactionHex ─────────────────────────────────────────────────

    describe('getTransactionHex', function () {
        const TXID = 'abc123';
        const HEX  = 'deadbeef';

        it('sends getrawtransaction with [txid, true]', async function () {
            axiosPostStub.resolves(makeResponse({ result: { hex: HEX } }));

            await connector.getTransactionHex(TXID);

            const data = axiosPostStub.firstCall.args[1];
            assert.strictEqual(data.method, 'getrawtransaction');
            assert.deepStrictEqual(data.params, [TXID, true]);
        });

        it('returns result.hex on success', async function () {
            axiosPostStub.resolves(makeResponse({ result: { hex: HEX } }));
            const result = await connector.getTransactionHex(TXID);
            assert.strictEqual(result, HEX);
        });

        it('throws when the HTTP request fails (axios rejects on non-2xx)', async function () {
            axiosPostStub.rejects(makeHttpError(503));
            await assert.rejects(
                () => connector.getTransactionHex(TXID),
                /503/
            );
        });

        it('throws when result or result.hex is missing', async function () {
            axiosPostStub.resolves(makeResponse({ result: {} }));
            await assert.rejects(
                () => connector.getTransactionHex(TXID),
                /Error/
            );
        });
    });

    // ── broadcastTx ───────────────────────────────────────────────────────

    describe('broadcastTx', function () {
        const TX_HEX  = 'cafebabe';
        const TX_HASH = 'txhash999';

        it('sends sendrawtransaction with [txHex]', async function () {
            axiosPostStub.resolves(makeResponse({ result: TX_HASH }));

            await connector.broadcastTx(TX_HEX);

            const data = axiosPostStub.firstCall.args[1];
            assert.strictEqual(data.method, 'sendrawtransaction');
            assert.deepStrictEqual(data.params, [TX_HEX]);
        });

        it('returns result on success', async function () {
            axiosPostStub.resolves(makeResponse({ result: TX_HASH }));
            const result = await connector.broadcastTx(TX_HEX);
            assert.strictEqual(result, TX_HASH);
        });

        it('surfaces the node error body when the HTTP request fails', async function () {
            // Core returns the JSON-RPC error body even on HTTP 500.
            axiosPostStub.rejects(makeHttpError(500, { error: { code: -26, message: 'dust' } }));
            await assert.rejects(
                () => connector.broadcastTx(TX_HEX),
                /HTTP 500/
            );
        });

        it('throws with node error JSON when result is missing', async function () {
            const nodeError = { code: -25, message: 'bad tx' };
            axiosPostStub.resolves(makeResponse({ result: null, error: nodeError }));
            await assert.rejects(
                () => connector.broadcastTx(TX_HEX),
                /bad tx/
            );
        });

        it('throws with "unknown error" when result and error are both missing', async function () {
            axiosPostStub.resolves(makeResponse({ result: null }));
            await assert.rejects(
                () => connector.broadcastTx(TX_HEX),
                /unknown error/
            );
        });
    });

    // ── waitForTx ─────────────────────────────────────────────────────────

    describe('waitForTx', function () {
        const TXID = 'txid-abc';

        it('returns true when getTransactionHex succeeds on first attempt', async function () {
            sinon.stub(connector, 'getTransactionHex').resolves('deadbeef');
            sinon.stub(connector, 'sleep').resolves();

            const result = await connector.waitForTx(TXID);
            assert.strictEqual(result, true);
        });

        it('returns false after timeout when getTransactionHex always throws', async function () {
            sinon.stub(connector, 'getTransactionHex').rejects(new Error('not found'));
            sinon.stub(connector, 'sleep').resolves();

            // Use a very short timeout (1 ms) to trigger immediate expiry
            const now = Date.now();
            const dateStub = sinon.stub(Date, 'now');
            // First call: start time; subsequent calls: past the deadline
            dateStub.onFirstCall().returns(now);
            dateStub.returns(now + 99999);

            try {
                const result = await connector.waitForTx(TXID, 10000);
                assert.strictEqual(result, false);
            } finally {
                dateStub.restore();
            }
        });
    });

    // ── getFeePerKilobyte ─────────────────────────────────────────────────

    describe('getFeePerKilobyte', function () {
        it('returns feerate when present in response', async function () {
            const feerate = 0.00012345;
            axiosPostStub.resolves(makeResponse({ result: { feerate } }));

            const result = await connector.getFeePerKilobyte(6);
            assert.strictEqual(result, feerate);
        });

        it('sends estimatesmartfee with the blocksNumber param', async function () {
            axiosPostStub.resolves(makeResponse({ result: { feerate: 0.0001 } }));

            await connector.getFeePerKilobyte(3);

            const data = axiosPostStub.firstCall.args[1];
            assert.strictEqual(data.method, 'estimatesmartfee');
            assert.deepStrictEqual(data.params, [3]);
        });

        it('falls back to the default feerate when feerate is absent', async function () {
            axiosPostStub.resolves(makeResponse({ result: {} }));
            const result = await connector.getFeePerKilobyte(6);
            assert.strictEqual(result, 0.00001000);
        });
    });
});
