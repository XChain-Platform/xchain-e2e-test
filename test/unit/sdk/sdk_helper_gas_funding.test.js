'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();

function loadHelper(ensureGasBalance) {
    class FakeSDK {}
    return proxyquire('../../sdk/helpers/sdkHelper', {
        'xchain-sdk': { XChainSDK: FakeSDK },
        '../../helpers/gasHelper': { ensureGasBalance }
    });
}

describe('sdkHelper gas funding', function () {
    it('routes gas through the shared rail-aware funder instead of submitting MINT', async function () {
        const funded = { txHash: 'send-from-faucet' };
        const ensureGasBalance = sinon.stub().resolves(funded);
        const helper = loadHelper(ensureGasBalance);
        const sdk = { submitAction: sinon.stub().rejects(new Error('SDK action must not run')) };
        const addr = { address: 'fixture-address', wif: 'fixture-wif' };

        const result = await helper.mintGas(sdk, addr, 5000);

        assert.strictEqual(result, funded);
        assert(ensureGasBalance.calledOnceWithExactly(addr, 5000));
        assert(sdk.submitAction.notCalled);
    });

    it('uses the fixture gas default through the shared funder', async function () {
        const ensureGasBalance = sinon.stub().resolves();
        const helper = loadHelper(ensureGasBalance);
        const addr = { address: 'fixture-address', wif: 'fixture-wif' };

        await helper.mintGas({}, addr);

        assert(ensureGasBalance.calledOnceWithExactly(addr, 100000));
    });
});
