/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform E2E - SDK-driven smart contracts (VM)
 *
 * DEPLOY a contract, EXECUTE a method, and read contract state, all
 * through the SDK. DEPLOY's hex-encoded bytecode auto-selects P2WSH, so
 * this also exercises the P2WSH two-phase reveal on a realistic payload.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');

const COUNTER_CONTRACT = `
    module.exports = {
        initialize: function() {
            xchain.state.set('count', '0');
        },
        increment: function() {
            let count = parseInt(xchain.state.get('count') || '0');
            xchain.state.set('count', String(count + 1));
            return String(count + 1);
        },
        getCount: function() {
            return xchain.state.get('count') || '0';
        }
    };
`;

function contractIndexOf(indexed) {
    const a = indexed && Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.action_index : null;
}

describe('[sdk] smart contracts (VM)', function () {
    this.timeout(0);

    let sdk, deployer, contractIndex;

    before(async function () {
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [sdk] deployer=' + deployer.address);
    });

    it('DEPLOY creates a contract (auto P2WSH for the bytecode)', async function () {
        const res = await submit(sdk,
            { action: 'DEPLOY', params: { code: COUNTER_CONTRACT, gasLimit: 200000, constructorParams: 'initialize' } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        console.log('    [sdk] DEPLOY encoding=' + res.encoding + ' status=' + res.indexed.status);
        expect(res.indexed.status).to.equal('valid');
        contractIndex = contractIndexOf(res.indexed);
        expect(contractIndex, 'contract action_index').to.not.equal(null);
        console.log('    [sdk] contractIndex=' + contractIndex);
    });

    it('EXECUTE runs a contract method', async function () {
        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'increment', params: [] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        console.log('    [sdk] EXECUTE status=' + res.indexed.status);
        expect(res.indexed.status).to.equal('valid');
    });

    it('contract state reflects the increment (SDK explorer read)', async function () {
        await mine(1);
        const state = await sdk.getContractState(contractIndex, 'count');
        const rows = (state && state.data) || [];
        const row = rows.find(r => r.state_key === 'count');
        expect(row, 'count state row').to.exist;
        // state_value is stored JSON-encoded (e.g. "1").
        expect(String(JSON.parse(row.state_value))).to.equal('1');
    });
});
