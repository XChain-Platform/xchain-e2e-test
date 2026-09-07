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
 * XChain Platform E2E - Contract Template Library: CROWDSALE (on-chain)
 *
 * Drives the REAL crowdsale template through the live regtest pipeline. Even
 * base64-encoded and comment-stripped, the crowdsale source overruns the
 * single-action payload cap by a few hundred bytes, so the deploy goes out as
 * DEPLOY v4 carriers assembled by a DEPLOY v2 (sdkHelper.deployContract picks
 * the path from chunkHelper.planDeploy). Slimming the template instead would
 * cost the demo-facing source its readability for a margin that any future
 * edit reopens.
 *
 *   1. DEPLOY crowdsale(owner, payTick, saleTick, rate, softCap, hardCap, dur, dec)
 *      The constructor emit.issue()s the sale token (contract becomes its owner).
 *   2. BATCH( DEPOSIT(sale, payTick, amount), EXECUTE(sale, "buy") )
 *      buy() attributes the deposit via getBalance (the wiring proof).
 *   3. EXECUTE finalize(): at the hard cap, SUCCESS.
 *   4. EXECUTE claim(): buyer mints saleTick = paid * rate.
 *   5. EXECUTE withdraw(): owner takes the proceeds (payTick).
 *
 * Run: COIN=bitcoin NETWORK=regtest npm run test:sdk
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { makeSdk, submit, deployContract, waitForBalance, fundedGasAddress, uniqueTick, mine, submitOpts } = require('./sdkHelper');
const { loadCompactTemplate } = require('./templateHelper');

async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    return row ? JSON.parse(row.state_value) : undefined;
}

function contractIndexOf(indexed) {
    const list = indexed && Array.isArray(indexed.actions) ? indexed.actions : [];
    const deploy = list.find(a => (a.action === 'DEPLOY')) || list[0] || null;
    return deploy ? deploy.action_index : null;
}

function haveConnectors() {
    return global.regtestMinerConnector && global.utxoTrackerConnector && global.nodeConnector;
}

describe('[sdk] template:crowdsale (on-chain custody)', function () {
    this.timeout(0);

    let SRC;                      // loaded in before() so a missing xchain-contracts skips this suite instead of aborting the whole run
    const RATE = 2, SOFT = 100, HARD = 200, DURATION = 1000, DEC = 0;
    const PAY_IN = HARD; // buy exactly the hard cap so finalize() succeeds immediately

    let sdk, owner, payTick, saleTick, contractIndex;

    before(async function () {
        if (!haveConnectors()) this.skip();
        // Load the contract template lazily so a missing xchain-contracts checkout
        // skips this suite with a clear reason instead of aborting the whole run.
        try {
            SRC = loadCompactTemplate('crowdsale');
        } catch (e) {
            console.log('    [crowdsale] SKIP: ' + e.message.split('\n')[0]);
            this.skip();
        }
        sdk = makeSdk();

        // Single actor is owner + buyer: simplest deterministic SUCCESS path.
        owner = await fundedGasAddress(sdk, 1);
        payTick = uniqueTick('PAY');
        saleTick = uniqueTick('SALE');

        const issue = await submit(sdk,
            { action: 'ISSUE', params: { tick: payTick, maxSupply: 1000000, maxMint: 100000, decimals: DEC, description: 'pay token', mintSupply: PAY_IN } },
            { pubkey: owner.address, change: owner.address }, submitOpts({ wif: owner.wif }));
        expect(issue.indexed.status, 'ISSUE payTick').to.equal('valid');

        console.log('    [crowdsale] owner=' + owner.address);
        console.log('    [crowdsale] payTick=' + payTick + ' saleTick=' + saleTick + ' rate=' + RATE + ' soft=' + SOFT + ' hard=' + HARD);
    });

    it('DEPLOY crowdsale issues the sale token in its constructor (chunked carriers + assembling DEPLOY)', async function () {
        const res = await deployContract(sdk,
            {
                code: SRC,
                gasLimit: 500000,
                constructorParams: [owner.address, payTick, saleTick, String(RATE), String(SOFT), String(HARD), String(DURATION), String(DEC)]
            },
            { pubkey: owner.address, change: owner.address }, submitOpts({ wif: owner.wif }));
        console.log('    [crowdsale] DEPLOY path=' + (res.deployPlan.single ? 'inline' : 'chunked x' + res.deployPlan.totalChunks) +
            ' encoding=' + res.encoding + ' status=' + res.indexed.status);
        expect(res.indexed.status, 'DEPLOY indexed').to.equal('valid');
        contractIndex = contractIndexOf(res.indexed);
        expect(contractIndex, 'contract action_index').to.not.equal(null);

        await mine(1);
        expect(await readState(sdk, contractIndex, 'status'), 'status OPEN').to.equal('OPEN');
        expect(await readState(sdk, contractIndex, 'saleTick'), 'saleTick recorded').to.equal(saleTick);
        console.log('    [crowdsale] contractIndex=' + contractIndex);
    });

    it('BATCH(DEPOSIT, EXECUTE buy) records the contribution via getBalance', async function () {
        const built = await sdk.batch()
            .deposit({ contractActionIndex: contractIndex, tick: payTick, quantity: PAY_IN })
            .execute({ contractActionIndex: contractIndex, method: 'buy', params: [] })
            .build();
        const res = await submit(sdk,
            { action: 'BATCH', params: { command: built.fields.COMMAND } },
            { pubkey: owner.address, change: owner.address }, submitOpts({ wif: owner.wif }));
        console.log('    [crowdsale] buy BATCH status=' + res.indexed.status);
        expect(res.indexed.status, 'buy BATCH indexed').to.equal('valid');

        await mine(1);
        expect(Number(await readState(sdk, contractIndex, 'raised')), 'raised == hard cap').to.equal(HARD);
        expect(await waitForBalance(sdk, owner.address, payTick, 0), 'buyer paid in').to.equal(0);
    });

    it('finalize at the hard cap -> SUCCESS, buyer claims sale tokens, owner withdraws proceeds', async function () {
        const fin = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'finalize', params: [] } },
            { pubkey: owner.address, change: owner.address }, submitOpts({ wif: owner.wif }));
        expect(fin.indexed.status, 'finalize indexed').to.equal('valid');
        await mine(1);
        expect(await readState(sdk, contractIndex, 'status'), 'status SUCCESS').to.equal('SUCCESS');

        const claim = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'claim', params: [] } },
            { pubkey: owner.address, change: owner.address }, submitOpts({ wif: owner.wif }));
        expect(claim.indexed.status, 'claim indexed').to.equal('valid');
        await mine(1);
        expect(await waitForBalance(sdk, owner.address, saleTick, PAY_IN * RATE), 'buyer minted paid*rate').to.equal(PAY_IN * RATE);

        const wd = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'withdraw', params: [] } },
            { pubkey: owner.address, change: owner.address }, submitOpts({ wif: owner.wif }));
        expect(wd.indexed.status, 'withdraw indexed').to.equal('valid');
        await mine(1);
        expect(await waitForBalance(sdk, owner.address, payTick, HARD), 'owner withdrew proceeds').to.equal(HARD);
    });
});
