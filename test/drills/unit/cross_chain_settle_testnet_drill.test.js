'use strict';

const assert = require('assert');
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();
const { fundedGasAddress } = require('../lib/testnetGasFunding');
const { waitForBlocks } = require('../lib/testnetBlockWait');

const ENV = {
    TESTNET_EXPLORER_URL: 'https://explorer.example/',
    TESTNET_TREASURY_WIF: 'stub-wif-must-not-leak',
    TESTNET_TREASURY_ADDRESS: 'stub-treasury-address'
};

function loadDrill(runCrossChainSettle = async () => ({ ok: true })) {
    class StubSdk {
        constructor(options) {
            this.options = options;
        }
    }

    const submit = () => {};
    const drill = proxyquire('../crossChainSettleTestnet.drill', {
        '../sdk/sdkHelper': { XChainSDK: StubSdk, submit },
        './lib/testnetSettleRunner': { runCrossChainSettle }
    });
    return { drill, submit };
}

describe('testnet cross-chain settlement drill', function () {
    it('does not start the live run when required', function () {
        let runs = 0;
        const runCrossChainSettle = async () => {
            runs += 1;
            return { ok: true };
        };

        loadDrill(runCrossChainSettle);

        assert.strictEqual(runs, 0);
    });

    it('builds dependencies from the landed testnet helpers', function () {
        const { drill } = loadDrill();
        const deps = drill.buildDrillDeps(ENV);

        assert.strictEqual(deps.fund, fundedGasAddress);
        assert.strictEqual(deps.waitBlocks, waitForBlocks);
        assert.deepStrictEqual(deps.treasury, {
            wif: ENV.TESTNET_TREASURY_WIF,
            address: ENV.TESTNET_TREASURY_ADDRESS
        });
        assert.deepStrictEqual(deps.btcSdk.options, {
            network: 'bitcoin-testnet',
            explorerUrl: 'https://explorer.example'
        });
        assert.deepStrictEqual(deps.dogeSdk.options, {
            network: 'dogecoin-testnet',
            explorerUrl: 'https://explorer.example'
        });
    });

    it('names a missing treasury key without exposing the supplied wif', function () {
        const { drill } = loadDrill();
        const env = { ...ENV };
        delete env.TESTNET_TREASURY_ADDRESS;

        assert.throws(
            () => drill.buildDrillDeps(env),
            (error) => error.message.includes('TESTNET_TREASURY_ADDRESS') &&
                !error.message.includes(ENV.TESTNET_TREASURY_WIF)
        );
    });

    it('passes the built dependencies to the runner and reports its verdict', async function () {
        let runnerArgs;
        const verdict = { ok: false, failedStep: 'fund-btc-maker', steps: [] };
        const runCrossChainSettle = async (args) => {
            runnerArgs = args;
            return verdict;
        };
        const { drill, submit } = loadDrill(runCrossChainSettle);
        const output = [];

        const code = await drill.main(ENV, (line) => output.push(line));

        assert.strictEqual(code, 1);
        assert.strictEqual(runnerArgs.fund, fundedGasAddress);
        assert.strictEqual(runnerArgs.waitBlocks, waitForBlocks);
        assert.strictEqual(runnerArgs.submitFn, submit);
        assert.strictEqual(runnerArgs.log instanceof Function, true);
        assert.deepStrictEqual(JSON.parse(output.at(-1)), verdict);
    });
});
