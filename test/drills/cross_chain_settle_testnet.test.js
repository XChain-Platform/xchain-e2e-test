'use strict';

const { XChainSDK, submit } = require('../sdk/helpers/sdkHelper');
const { fundedGasAddress } = require('./lib/testnetGasFunding');
const { waitForBlocks } = require('./lib/testnetBlockWait');
const { readTestnetTreasury, buildTestnetSdk } = require('./lib/testnetDrillEnv');
const { readSettleTopology } = require('./lib/testnetSettleTopology');
const { runCrossChainSettle } = require('./lib/testnetSettleRunner');

function buildDrillDeps(env) {
    const topology = readSettleTopology(env);
    const treasury = readTestnetTreasury(env);
    const btcSdk = buildTestnetSdk(XChainSDK, 'BTC', topology.explorerUrl);
    const dogeSdk = buildTestnetSdk(XChainSDK, 'DOGE', topology.explorerUrl);

    return {
        topology,
        fund: fundedGasAddress,
        waitBlocks: waitForBlocks,
        btcSdk,
        dogeSdk,
        treasury
    };
}

async function main(env, write = console.log) {
    const verdict = await runCrossChainSettle({
        ...buildDrillDeps(env),
        submitFn: submit,
        log: write
    });
    write(JSON.stringify(verdict, null, 2));
    return verdict.ok ? 0 : 1;
}

module.exports = { buildDrillDeps, main };

if (require.main === module) {
    main(process.env)
        .then((code) => { process.exitCode = code; })
        .catch((error) => {
            console.error(error && error.message ? error.message : String(error));
            process.exitCode = 1;
        });
}
