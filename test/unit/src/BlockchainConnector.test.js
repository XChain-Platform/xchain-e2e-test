'use strict';

const assert = require('assert');
const sinon = require('sinon');

// ── cross-fetch injection ──────────────────────────────────────────────────
// BlockchainConnector captures `fetch` in a module-level const at require-time.
// We inject a stub into require.cache BEFORE the first require so the module
// picks up the stub instead of the real network function.

let fetchStub;
let BlockchainConnector;
let crossFetchCacheKey;

before(function () {
    fetchStub = sinon.stub();
    crossFetchCacheKey = require.resolve('cross-fetch');

    // Replace the cached cross-fetch export with our stub
    require.cache[crossFetchCacheKey] = {
        id: crossFetchCacheKey,
        filename: crossFetchCacheKey,
        loaded: true,
        exports: fetchStub
    };

    // Now require the connector — it will capture our stub as its `fetch`
    BlockchainConnector = require('../../../src/BlockchainConnector');
});

after(function () {
    // Restore the real cross-fetch so other test files are unaffected
    delete require.cache[crossFetchCacheKey];
    delete require.cache[require.resolve('../../../src/BlockchainConnector')];
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

    beforeEach(function () {
        fetchStub.reset();
        connector = new BlockchainConnector(URL, PORT, USER, PASS);
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
            fetchStub.resolves(makeOkResponse({ result: fakeResult }));

            await connector.getNetworkInfo();

            const [url, opts] = fetchStub.firstCall.args;
            assert.strictEqual(url, connector.url);

            const body = JSON.parse(opts.body);
            assert.strictEqual(body.jsonrpc, '2.0');
            assert.strictEqual(body.method, 'getnetworkinfo');
            assert.strictEqual(body.id, 1);
        });

        it('sends a valid Basic auth header', async function () {
            fetchStub.resolves(makeOkResponse({ result: { version: 1 } }));
            await connector.getNetworkInfo();

            const [, opts] = fetchStub.firstCall.args;
            assert.strictEqual(opts.headers['Authorization'], expectedAuth(USER, PASS));
        });

        it('returns the result on success', async function () {
            const fakeResult = { subversion: '/Satoshi:0.21/' };
            fetchStub.resolves(makeOkResponse({ result: fakeResult }));

            const result = await connector.getNetworkInfo();
            assert.deepStrictEqual(result, fakeResult);
        });

        it('throws when HTTP response is not ok', async function () {
            fetchStub.resolves(makeErrorResponse(500));
            await assert.rejects(
                () => connector.getNetworkInfo(),
                /HTTP error/
            );
        });

        it('throws when response has no result', async function () {
            fetchStub.resolves(makeOkResponse({ result: null }));
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
            fetchStub.resolves(makeOkResponse({ result: { hex: HEX } }));

            await connector.getTransactionHex(TXID);

            const [, opts] = fetchStub.firstCall.args;
            const body = JSON.parse(opts.body);
            assert.strictEqual(body.method, 'getrawtransaction');
            assert.deepStrictEqual(body.params, [TXID, true]);
        });

        it('returns result.hex on success', async function () {
            fetchStub.resolves(makeOkResponse({ result: { hex: HEX } }));
            const result = await connector.getTransactionHex(TXID);
            assert.strictEqual(result, HEX);
        });

        it('throws when HTTP response is not ok', async function () {
            fetchStub.resolves(makeErrorResponse(503));
            await assert.rejects(
                () => connector.getTransactionHex(TXID),
                /HTTP error/
            );
        });

        it('throws when result or result.hex is missing', async function () {
            fetchStub.resolves(makeOkResponse({ result: {} }));
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
            fetchStub.resolves(makeOkResponse({ result: TX_HASH }));

            await connector.broadcastTx(TX_HEX);

            const [, opts] = fetchStub.firstCall.args;
            const body = JSON.parse(opts.body);
            assert.strictEqual(body.method, 'sendrawtransaction');
            assert.deepStrictEqual(body.params, [TX_HEX]);
        });

        it('returns result on success', async function () {
            fetchStub.resolves(makeOkResponse({ result: TX_HASH }));
            const result = await connector.broadcastTx(TX_HEX);
            assert.strictEqual(result, TX_HASH);
        });

        it('throws when HTTP response is not ok', async function () {
            fetchStub.resolves(makeErrorResponse(400));
            await assert.rejects(
                () => connector.broadcastTx(TX_HEX),
                /Error/
            );
        });

        it('throws with node error JSON when result is missing', async function () {
            const nodeError = { code: -25, message: 'bad tx' };
            fetchStub.resolves(makeOkResponse({ result: null, error: nodeError }));
            await assert.rejects(
                () => connector.broadcastTx(TX_HEX),
                /bad tx/
            );
        });

        it('throws with "unknown error" when result and error are both missing', async function () {
            fetchStub.resolves(makeOkResponse({ result: null }));
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
            fetchStub.resolves(makeOkResponse({ result: { feerate } }));

            const result = await connector.getFeePerKilobyte(6);
            assert.strictEqual(result, feerate);
        });

        it('sends estimatesmartfee with the blocksNumber param', async function () {
            fetchStub.resolves(makeOkResponse({ result: { feerate: 0.0001 } }));

            await connector.getFeePerKilobyte(3);

            const [, opts] = fetchStub.firstCall.args;
            const body = JSON.parse(opts.body);
            assert.strictEqual(body.method, 'estimatesmartfee');
            assert.deepStrictEqual(body.params, [3]);
        });

        it('throws TypeError when feerate is absent because isRegtest() does not exist', async function () {
            // The source calls `this.isRegtest()` which is NOT defined on the class.
            fetchStub.resolves(makeOkResponse({ result: {} }));
            await assert.rejects(
                () => connector.getFeePerKilobyte(6),
                TypeError
            );
        });
    });
});
