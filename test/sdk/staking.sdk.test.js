/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform E2E - SDK-driven contract-targeted staking
 *
 * One of the newest primitives: DEPLOY v1 (stakeable contract with
 * COOLDOWN_BLOCKS + SLASH_DESTINATION) then STAKE v3 (stake a token
 * against that contract) — driven through sdk.submitAction. Multi-chain
 * by design, exercised here against the XCHAIN token on BTC regtest.
 *
 ********************************************************************/

const { expect } = require('chai');
const crypto = require('crypto');
const { makeSdk, submit, fundedGasAddress, submitOpts, GAS_TICK } = require('./sdkHelper');

// Ed25519 validator signing pubkey as 64-hex (matches the connector suite).
function newSigningPubkey() {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    return publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
}

const STAKE_GATED_CONTRACT = `
    module.exports = {
        isStaked: function() {
            let pubkey = xchain.getInputParam(0)
            let amount = xchain.contract.getStake(pubkey, 'XCHAIN')
            return xchain.math.gte(amount, '100') ? 'yes' : 'no'
        },
        getTotalXchain: function() {
            return xchain.contract.getTotalStaked('XCHAIN')
        }
    };
`;

function contractIndexOf(indexed) {
    const a = indexed && Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.action_index : null;
}

describe('[sdk] contract-targeted staking (DEPLOY v1 -> STAKE v3)', function () {
    this.timeout(0);

    let sdk, deployer, staker, contractIndex;

    before(async function () {
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        staker = await fundedGasAddress(sdk, 1);
        console.log('    [sdk] deployer=' + deployer.address + ' staker=' + staker.address);
    });

    it('DEPLOY v1 creates a stakeable contract (COOLDOWN_BLOCKS + SLASH_DESTINATION)', async function () {
        const res = await submit(sdk,
            {
                action: 'DEPLOY',
                params: { code: STAKE_GATED_CONTRACT, gasLimit: 300000, cooldownBlocks: 50, slashDestination: 'BURN' },
            },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        console.log('    [sdk] DEPLOY v1 version=' + res.version + ' encoding=' + res.encoding + ' status=' + res.indexed.status);
        expect(res.version, 'should select DEPLOY v1').to.equal(1);
        expect(res.indexed.status).to.equal('valid');
        contractIndex = contractIndexOf(res.indexed);
        expect(contractIndex, 'contract action_index').to.not.equal(null);
    });

    it('STAKE v3 stakes XCHAIN against the contract', async function () {
        const res = await submit(sdk,
            {
                action: 'STAKE',
                params: {
                    amount: '200.00000000',
                    signingPubkey: newSigningPubkey(),
                    targetContractIndex: contractIndex,
                    tick: GAS_TICK,
                },
            },
            { pubkey: staker.address, change: staker.address },
            submitOpts({ wif: staker.wif })
        );
        console.log('    [sdk] STAKE version=' + res.version + ' encoding=' + res.encoding + ' status=' + res.indexed.status);
        expect(res.version, 'should select STAKE v3').to.equal(3);
        expect(res.indexed.status).to.equal('valid');
    });
});
