'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { awaitCrossChainMatch } = require('../lib/testnetSettleMatchWait');

function response(body) {
    return { ok: true, status: 200, json: async () => body };
}

function scriptedFetch(bodies, urls) {
    let index = 0;
    return async function fetchImpl(url) {
        urls.push(url);
        assert.ok(index < bodies.length, 'unexpected explorer request: ' + url);
        return response(bodies[index++]);
    };
}

function transaction(actionIndex) {
    return { actions: [{ action_index: actionIndex - 1, action: 'ISSUE' }, { action_index: actionIndex, action: 'ORDER' }] };
}

function waitOptions(fetchImpl, extra) {
    return Object.assign({
        explorerUrl: 'https://explorer.example/',
        coin: 'TBTC',
        orderTxid: 'order-txid',
        timeoutMs: 100,
        pollIntervalMs: 10,
        now: () => 0,
        sleep: async () => {},
        fetchImpl
    }, extra);
}

describe('testnet cross-chain match wait', function () {
    it('resolves a finalized match that references the ORDER on the a side', async function () {
        const urls = [];
        const match = { status: 'finalized', a_chain: 'BTC', a_action_index: '41', b_chain: 'DOGE', b_action_index: 90 };
        const fetchImpl = scriptedFetch([transaction(41), { total: 1, data: [match] }], urls);

        assert.strictEqual(await awaitCrossChainMatch(waitOptions(fetchImpl)), match);
        assert.deepStrictEqual(urls, [
            'https://explorer.example/TBTC/api/transaction/order-txid/tx_hash',
            'https://explorer.example/TBTC/api/cross_chain_matches'
        ]);
    });

    it('resolves a finalized match that references the ORDER on the b side', async function () {
        const urls = [];
        const match = { status: 'finalized', a_chain: 'DOGE', a_action_index: 90, b_chain: 'BTC', b_action_index: 41 };
        const fetchImpl = scriptedFetch([transaction(41), { data: [match] }], urls);

        assert.strictEqual(await awaitCrossChainMatch(waitOptions(fetchImpl)), match);
    });

    it('ignores a finalized match for another action index', async function () {
        const urls = [];
        let clock = 0;
        const wrong = { status: 'finalized', a_chain: 'BTC', a_action_index: 40, b_chain: 'DOGE', b_action_index: 90 };
        const retracted = { status: 'retracted', a_chain: 'BTC', a_action_index: 41, b_chain: 'DOGE', b_action_index: 89 };
        const match = { status: 'finalized', a_chain: 'BTC', a_action_index: 41, b_chain: 'DOGE', b_action_index: 91 };
        const fetchImpl = scriptedFetch([transaction(41), { data: [wrong, retracted] }, { data: [wrong, match] }], urls);
        const options = waitOptions(fetchImpl, {
            now: () => clock,
            sleep: async (ms) => { clock += ms; }
        });

        assert.strictEqual(await awaitCrossChainMatch(options), match);
        assert.strictEqual(urls.length, 3);
    });

    it('rejects with the last match count after the timeout', async function () {
        const urls = [];
        let clock = 0;
        const wrong = { status: 'finalized', a_chain: 'BTC', a_action_index: 40 };
        const fetchImpl = scriptedFetch([
            transaction(41),
            { total: 1, data: [wrong] },
            { total: 7, data: [wrong, wrong] }
        ], urls);
        const options = waitOptions(fetchImpl, {
            timeoutMs: 10,
            pollIntervalMs: 6,
            now: () => clock,
            sleep: async (ms) => { clock += ms; }
        });

        await assert.rejects(awaitCrossChainMatch(options), /last match count: 7/);
        assert.strictEqual(clock, 12);
        assert.strictEqual(urls.length, 3);
    });

    it('contains no call to a block-production method', function () {
        const source = fs.readFileSync(path.join(__dirname, '../lib/testnetSettleMatchWait.js'), 'utf8');
        assert.doesNotMatch(source, /\bmine\s*\(/);
    });
});
