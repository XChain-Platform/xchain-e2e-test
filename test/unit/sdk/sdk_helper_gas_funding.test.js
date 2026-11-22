'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const Module = require('module');

const HELPER_PATH = require.resolve('../../sdk/helpers/sdkHelper');

function recordingAsync(value) {
    const calls = [];
    const fn = async (...args) => {
        calls.push(args);
        return value;
    };
    fn.calls = calls;
    return fn;
}

function loadHelper(ensureGasBalance) {
    class FakeSDK {}
    const originalLoad = Module._load;
    delete require.cache[HELPER_PATH];
    Module._load = function (request, parent, isMain) {
        if (request === 'xchain-sdk') return { XChainSDK: FakeSDK };
        if (request === '../../helpers/gasHelper' && parent && parent.filename === HELPER_PATH) {
            return { ensureGasBalance };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return require(HELPER_PATH);
    } finally {
        Module._load = originalLoad;
        delete require.cache[HELPER_PATH];
    }
}

describe('sdkHelper gas funding', function () {
    it('routes gas through the shared rail-aware funder instead of submitting MINT', async function () {
        const funded = { txHash: 'send-from-faucet' };
        const ensureGasBalance = recordingAsync(funded);
        const helper = loadHelper(ensureGasBalance);
        const sdk = { submitAction: () => { throw new Error('SDK action must not run'); } };
        const addr = { address: 'fixture-address', wif: 'fixture-wif' };

        const result = await helper.mintGas(sdk, addr, 5000);

        assert.strictEqual(result, funded);
        assert.deepStrictEqual(ensureGasBalance.calls, [[addr, 5000]]);
    });

    it('uses the fixture gas default through the shared funder', async function () {
        const ensureGasBalance = recordingAsync();
        const helper = loadHelper(ensureGasBalance);
        const addr = { address: 'fixture-address', wif: 'fixture-wif' };

        await helper.mintGas({}, addr);

        assert.deepStrictEqual(ensureGasBalance.calls, [[addr, 100000]]);
    });
});
