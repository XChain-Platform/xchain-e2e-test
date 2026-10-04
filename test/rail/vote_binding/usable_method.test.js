'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const {
    makeSdk,
    submit,
    fundedGasAddress,
    mine,
    uniqueTick,
    submitOpts
} = require('../../sdk/helpers/sdkHelper');
const {
    CALLBACK_TARGET_SOURCE,
    USABLE_METHOD_CASES,
    expectMode
} = require('./helpers/usable_method_cases');

const MODE = expectMode(process.env.XC_VOTE_CALLBACK_BINDING_EXPECT);

function actionIndexOf(res){
    const actions = res && res.indexed && res.indexed.actions;
    if(!Array.isArray(actions) || actions.length === 0)
        throw new Error('no indexed actions');
    return actions[0].action_index;
}

describe('VOTE callback binding usable method', function(){
    this.timeout(0);

    let sdk;
    let issuer;
    let tick;
    let callbackContract;

    before(async function(){
        sdk = makeSdk({ compactAddresses: false });
        issuer = await fundedGasAddress(sdk, 0.05);
        tick = uniqueTick('VBM');

        const issue = await submit(sdk, {
            action: 'ISSUE',
            params: {
                tick,
                maxSupply: 10000000,
                maxMint: 100000,
                decimals: 0,
                description: 'vote callback method rail',
                mintSupply: 1000
            }
        }, {
            pubkey: issuer.address,
            change: issuer.address
        }, submitOpts({ wif: issuer.wif }));
        assert.strictEqual(String(issue.indexed.status), 'valid');

        const deploy = await submit(sdk, {
            action: 'DEPLOY',
            params: {
                code: CALLBACK_TARGET_SOURCE,
                gasLimit: 200000,
                constructorParams: 'initialize'
            }
        }, {
            pubkey: issuer.address,
            change: issuer.address
        }, submitOpts({ wif: issuer.wif }));
        assert.strictEqual(String(deploy.indexed.status), 'valid');
        callbackContract = actionIndexOf(deploy);
        await mine(1);
    });

    for(const [index, testCase] of USABLE_METHOD_CASES.entries()){
        it(testCase.name + ' is ' + testCase[MODE] + ' when the gate is ' + MODE, async function(){
            const endBlock = (await global.nodeConnector.getBlockCount()) + 30;
            const res = await submit(sdk, {
                action: 'VOTE',
                params: {
                    version: 0,
                    tick,
                    endBlock,
                    options: 'YES,NO',
                    maxSelections: 1,
                    tallyMode: 'approval',
                    weightMode: 'balance',
                    quorum: '0.05',
                    minVoters: 1,
                    question: 'Usable callback method ' + index,
                    callbackContract,
                    callbackMethod: testCase.method,
                    callbackOn: 'pass'
                }
            }, {
                pubkey: issuer.address,
                change: issuer.address
            }, submitOpts({ wif: issuer.wif, requireValid: false }));

            assert.strictEqual(String(res.indexed.status), testCase[MODE]);
        });
    }
});
