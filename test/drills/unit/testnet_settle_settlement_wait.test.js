'use strict';

const assert = require('assert');
const {
    awaitBtcSettlement,
    observeDogeSettlement
} = require('../lib/testnetSettleSettlementWait');

function fakeClock() {
    let time = 0;
    return {
        now: () => time,
        sleep: async (ms) => { time += ms; }
    };
}

function scriptedFetch(bodies) {
    const calls = [];
    let index = 0;
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        const body = bodies[Math.min(index, bodies.length - 1)];
        index++;
        return { ok: true, status: 200, json: async () => body };
    };
    return { calls, fetchImpl };
}

function waitArgs(overrides) {
    const clock = fakeClock();
    return Object.assign({
        explorerUrl: '/explorer/',
        coin: 'BTC',
        matchId: 'match-1',
        dogeMakerBtcRecv: 'btc-recipient',
        timeoutMs: 20,
        pollIntervalMs: 5,
        now: clock.now,
        sleep: clock.sleep
    }, overrides || {});
}

describe('testnet settlement wait', function () {
    it('waits for the BTC escrow release to reach the intended recipient', async function () {
        const script = scriptedFetch([
            { data: [{ match_id: 'match-1', status: 'settled', released_to: 'another-address' }] },
            { data: [{ match_id: 'match-1', status: 'settled', released_to: 'btc-recipient' }] }
        ]);
        const row = await awaitBtcSettlement(waitArgs({ fetchImpl: script.fetchImpl }));

        assert.strictEqual(row.released_to, 'btc-recipient');
        assert.strictEqual(script.calls.length, 2);
        assert.strictEqual(script.calls[0].url,
            '/explorer/BTC/api/cross_chain_settlements/match-1/match');
        assert.deepStrictEqual(script.calls[0].options, { method: 'GET' });
    });

    it('rejects a BTC timeout with the last settlement status', async function () {
        const script = scriptedFetch([
            { status: 'waiting', data: [] },
            { status: 'mirror-delayed', data: [] }
        ]);
        let caught = null;
        try {
            await awaitBtcSettlement(waitArgs({ fetchImpl: script.fetchImpl, timeoutMs: 5 }));
        } catch (error) {
            caught = error;
        }

        assert(caught instanceof Error);
        assert.match(caught.message, /mirror-delayed/);
        assert.strictEqual(caught.lastStatus, 'mirror-delayed');
    });

    it('returns an unsettled DOGE observation on timeout', async function () {
        const script = scriptedFetch([{
            data: [{ match_id: 'match-1', status: 'open', released_to: 'doge-recipient' }]
        }]);
        const result = await observeDogeSettlement(waitArgs({
            coin: 'DOGE',
            fetchImpl: script.fetchImpl,
            timeoutMs: 10
        }));

        assert.deepStrictEqual(result, { settled: false, lastStatus: 'open' });
        assert.strictEqual(script.calls.length, 3);
    });
});
