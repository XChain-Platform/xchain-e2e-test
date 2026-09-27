'use strict';

const assert = require('assert');
const { runCrossChainSettle } = require('../lib/testnetSettleRunner');

const TREASURY = { address: 'treasury-address', wif: 'treasury-private-wif' };
const TOPOLOGY = {
    explorerUrl: 'https://explorer.example',
    btcCoin: 'TBTC',
    dogeCoin: 'TDOGE',
    deadlines: { inclusionMs: 11, matchMs: 22, settleMs: 33 }
};

function harness(overrides) {
    const calls = [];
    const logs = [];
    const makers = {
        'btc-sdk': { address: 'btc-maker', wif: 'btc-maker-wif', txid: 'btc-fund-tx' },
        'doge-sdk': { address: 'doge-maker', wif: 'doge-maker-wif', txid: 'doge-fund-tx' }
    };
    const fund = async (args) => {
        calls.push({ name: 'fund', args });
        return makers[args.sdk];
    };
    const waitBlocks = async (args) => calls.push({ name: 'wait-blocks', args });
    const legs = {
        placeDogeCounterOrder: async (args) => {
            calls.push({ name: 'place-doge-counter-order', args });
            await args.waitBlocks(1);
            return { dogeTick: args.uniqueTick('DOGE'), orderTxid: 'doge-order', btcRecv: args.btcRecv };
        },
        placeBtcCrossOrder: async (args) => {
            calls.push({ name: 'place-btc-order', args });
            await args.waitBlocks(1);
            return { tick: args.uniqueTick('BTC'), orderTxid: 'btc-order' };
        },
        awaitCrossChainMatch: async (args) => {
            calls.push({ name: 'await-match', args });
            return { match_id: 'match-7' };
        },
        awaitBtcSettlement: async (args) => {
            calls.push({ name: 'await-btc-settlement', args });
            return { status: 'settled' };
        },
        observeDogeSettlement: async (args) => {
            calls.push({ name: 'observe-doge-settlement', args });
            return { settled: true, lastStatus: 'settled' };
        }
    };
    Object.assign(legs, overrides || {});
    return { calls, logs, fund, waitBlocks, legs };
}

async function run(h) {
    return runCrossChainSettle({
        topology: TOPOLOGY,
        fund: h.fund,
        waitBlocks: h.waitBlocks,
        btcSdk: 'btc-sdk',
        dogeSdk: 'doge-sdk',
        submitFn: 'submit-fn',
        treasury: TREASURY,
        legs: h.legs,
        log: (line) => h.logs.push(line)
    });
}

describe('testnet cross-chain settlement runner', function () {
    it('runs every step in order and records a successful verdict', async function () {
        const h = harness();
        const verdict = await run(h);

        assert.strictEqual(verdict.ok, true);
        assert.strictEqual(verdict.failedStep, null);
        assert.deepStrictEqual(verdict.steps.map((step) => step.name), [
            'fund-btc-maker',
            'fund-doge-maker',
            'place-doge-counter-order',
            'place-btc-order',
            'await-match',
            'await-btc-settlement',
            'observe-doge-settlement'
        ]);
        assert.deepStrictEqual(h.calls.map((call) => call.name), [
            'fund', 'fund',
            'place-doge-counter-order', 'wait-blocks',
            'place-btc-order', 'wait-blocks',
            'await-match', 'await-btc-settlement', 'observe-doge-settlement'
        ]);
    });

    it('passes the topology deadline to every wait', async function () {
        const h = harness();
        await run(h);

        const waits = h.calls.filter((call) => call.name === 'wait-blocks');
        assert.deepStrictEqual(waits.map((call) => call.args), [
            {
                explorerUrl: TOPOLOGY.explorerUrl,
                coin: TOPOLOGY.dogeCoin,
                blocks: 1,
                timeoutMs: TOPOLOGY.deadlines.inclusionMs
            },
            {
                explorerUrl: TOPOLOGY.explorerUrl,
                coin: TOPOLOGY.btcCoin,
                blocks: 1,
                timeoutMs: TOPOLOGY.deadlines.inclusionMs
            }
        ]);
        assert.strictEqual(h.calls.find((call) => call.name === 'await-match').args.timeoutMs,
            TOPOLOGY.deadlines.matchMs);
        assert.strictEqual(h.calls.find((call) => call.name === 'await-btc-settlement').args.timeoutMs,
            TOPOLOGY.deadlines.settleMs);
        assert.strictEqual(h.calls.find((call) => call.name === 'observe-doge-settlement').args.timeoutMs,
            TOPOLOGY.deadlines.settleMs);
    });

    it('names a rejected match wait and skips both settlement waits', async function () {
        const h = harness({
            awaitCrossChainMatch: async (args) => {
                h.calls.push({ name: 'await-match', args });
                throw new Error('match unavailable');
            }
        });
        const verdict = await run(h);

        assert.strictEqual(verdict.ok, false);
        assert.strictEqual(verdict.failedStep, 'await-match');
        assert.deepStrictEqual(verdict.steps.at(-1).result, { error: 'match unavailable' });
        assert.strictEqual(h.calls.some((call) => call.name === 'await-btc-settlement'), false);
        assert.strictEqual(h.calls.some((call) => call.name === 'observe-doge-settlement'), false);
    });

    it('keeps an unsettled DOGE observation as a successful result', async function () {
        const observation = { settled: false, lastStatus: 'open' };
        const h = harness({ observeDogeSettlement: async () => observation });
        const verdict = await run(h);

        assert.strictEqual(verdict.ok, true);
        assert.deepStrictEqual(verdict.steps.at(-1), {
            name: 'observe-doge-settlement',
            ms: verdict.steps.at(-1).ms,
            result: observation
        });
    });

    it('does not log or record the treasury private key', async function () {
        const h = harness({
            awaitCrossChainMatch: async () => {
                throw new Error('failed with ' + TREASURY.wif);
            }
        });
        const verdict = await run(h);
        const output = h.logs.join('\n') + '\n' + JSON.stringify(verdict);

        assert.strictEqual(output.includes(TREASURY.wif), false);
        assert.match(output, /\[redacted\]/);
        assert.strictEqual(verdict.steps[0].result.wif, undefined);
    });
});
