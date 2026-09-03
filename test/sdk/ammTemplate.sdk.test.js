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
 * XChain Platform E2E - Contract Template Library: AMM (on-chain)
 *
 * Drives the REAL constant-product AMM template from xchain-contracts
 * through the live regtest pipeline. This is the most demanding custody
 * proof in the library. It exercises every piece of the value model:
 *
 *   - DEPLOY: base64 of the compacted source runs ~900 bytes past the single-
 *     action payload cap, so it ships as DEPLOY v4 carriers assembled by a
 *     DEPLOY v2 (sdkHelper.deployContract picks the path); the constructor
 *     emit.issue()s the LP tick (contract owns it)
 *   - addLiquidity: BATCH(DEPOSIT A, DEPOSIT B, EXECUTE); reads getBalance
 *     for BOTH tokens, then emit.mint()s LP shares to the provider
 *   - swap: BATCH(DEPOSIT in, EXECUTE); getBalance-derived input, emit.send
 *     of the output, with k (reserveA*reserveB) growing by the 0.3% fee
 *   - removeLiquidity: BATCH(DEPOSIT LP, EXECUTE); burns LP via emit.destroy
 *     and returns both reserves via two emit.send()s
 *
 * The LP tick is a first-class contract-issued tick (the whole point of the
 * template), so the round trip proves the indexer getBalance/getTokenInfo
 * wiring across issue / mint / deposit / send / destroy.
 *
 * Run (host with regtest stack + Node 22):
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk
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
    // The constructor's emit.issue() of the LP tick lands as a sibling action in the
    // same DEPLOY tx, and getTransaction returns them emitted-first ([ISSUE, DEPLOY]),
    // so actions[0] is the ISSUE; find the DEPLOY explicitly to get the contract index.
    const list = indexed && Array.isArray(indexed.actions) ? indexed.actions : [];
    const deploy = list.find(a => (a.action === 'DEPLOY')) || list[0] || null;
    return deploy ? deploy.action_index : null;
}

function haveConnectors() {
    return global.regtestMinerConnector && global.utxoTrackerConnector && global.nodeConnector;
}

describe('[sdk] template:amm (LP-as-real-tick round trip)', function () {
    this.timeout(0);

    let AMM_SRC;               // loaded in before() so a missing xchain-contracts skips this suite instead of aborting the whole run
    const DEC = 8;             // divisible pair so swap output (a fraction) is representable
    const LIQ = 10000;         // deposited per side for the initial liquidity
    const SWAP_IN = 1000;      // tokenA sold into the pool
    const MINT_A = LIQ + SWAP_IN; // provider also funds the swap from the same address

    let sdk, lp, tokenA, tokenB, lpTick, contractIndex;

    before(async function () {
        if (!haveConnectors()) this.skip();

        // Load the contract template lazily: a missing xchain-contracts checkout
        // (e.g. the e2e-test container image without it bundled) skips this suite
        // with a clear reason rather than throwing at file load and aborting the
        // entire test:sdk run.
        try {
            AMM_SRC = loadCompactTemplate('amm');
        } catch (e) {
            console.log('    [amm] SKIP: ' + e.message.split('\n')[0]);
            this.skip();
        }

        // Size does not gate this suite: deployContract routes anything over the
        // single-action cap through DEPLOY v4 carriers plus an assembling DEPLOY v2,
        // so the flagship template drill deploys and runs on chain instead of
        // self-skipping on size.
        sdk = makeSdk();

        lp = await fundedGasAddress(sdk, 1);

        tokenA = uniqueTick('AMA');
        tokenB = uniqueTick('AMB');
        lpTick = uniqueTick('AMLP');

        const iA = await submit(sdk,
            { action: 'ISSUE', params: { tick: tokenA, maxSupply: 1000000000, maxMint: 100000000, decimals: DEC, description: 'amm tokenA', mintSupply: MINT_A } },
            { pubkey: lp.address, change: lp.address }, submitOpts({ wif: lp.wif }));
        expect(iA.indexed.status, 'ISSUE tokenA').to.equal('valid');

        const iB = await submit(sdk,
            { action: 'ISSUE', params: { tick: tokenB, maxSupply: 1000000000, maxMint: 100000000, decimals: DEC, description: 'amm tokenB', mintSupply: LIQ } },
            { pubkey: lp.address, change: lp.address }, submitOpts({ wif: lp.wif }));
        expect(iB.indexed.status, 'ISSUE tokenB').to.equal('valid');

        console.log('    [amm] lp=' + lp.address);
        console.log('    [amm] tokenA=' + tokenA + ' tokenB=' + tokenB + ' lpTick=' + lpTick);
    });

    it('DEPLOY issues the LP tick in the constructor', async function () {
        const res = await deployContract(sdk,
            {
                code: AMM_SRC,
                gasLimit: 400000,
                constructorParams: [tokenA, tokenB, lpTick]
            },
            { pubkey: lp.address, change: lp.address }, submitOpts({ wif: lp.wif }));
        console.log('    [amm] DEPLOY path=' + (res.deployPlan.single ? 'inline' : 'chunked x' + res.deployPlan.totalChunks) +
            ' encoding=' + res.encoding + ' status=' + res.indexed.status);
        expect(res.indexed.status, 'DEPLOY indexed').to.equal('valid');
        contractIndex = contractIndexOf(res.indexed);
        expect(contractIndex, 'contract action_index').to.not.equal(null);

        await mine(1);
        const info = (typeof sdk.getTokenInfo === 'function')
            ? await sdk.getTokenInfo(lpTick).catch(() => null)
            : null;
        expect(await readState(sdk, contractIndex, 'lpTick'), 'lpTick recorded in state').to.equal(lpTick);
        expect(await readState(sdk, contractIndex, 'totalShares'), 'starts with zero shares').to.equal('0');
        console.log('    [amm] contractIndex=' + contractIndex + ' lpTokenInfo=' + JSON.stringify(info));
    });

    it('addLiquidity (BATCH: DEPOSIT A, DEPOSIT B, EXECUTE) mints LP shares', async function () {
        const built = await sdk.batch()
            .deposit({ contractActionIndex: contractIndex, tick: tokenA, quantity: LIQ })
            .deposit({ contractActionIndex: contractIndex, tick: tokenB, quantity: LIQ })
            .execute({ contractActionIndex: contractIndex, method: 'addLiquidity', params: [] })
            .build();
        expect(built.actionString, 'two DEPOSITs then EXECUTE').to.match(/^BATCH\|\d+\|DEPOSIT\|.*;DEPOSIT\|.*;EXECUTE\|/);

        const res = await submit(sdk,
            { action: 'BATCH', params: { command: built.fields.COMMAND } },
            { pubkey: lp.address, change: lp.address }, submitOpts({ wif: lp.wif }));
        console.log('    [amm] addLiquidity status=' + res.indexed.status);
        expect(res.indexed.status, 'addLiquidity indexed').to.equal('valid');

        await mine(1);
        expect(Number(await readState(sdk, contractIndex, 'reserveA')), 'reserveA').to.equal(LIQ);
        expect(Number(await readState(sdk, contractIndex, 'reserveB')), 'reserveB').to.equal(LIQ);
        const shares = Number(await readState(sdk, contractIndex, 'totalShares'));
        expect(shares, 'totalShares = sqrt(depA*depB)').to.equal(LIQ);
        // The LP tick is a real tick credited to the provider.
        expect(await waitForBalance(sdk, lp.address, lpTick, LIQ), 'provider holds LP shares').to.equal(LIQ);
    });

    it('swap (BATCH: DEPOSIT in, EXECUTE) returns the other token and grows k', async function () {
        const kBefore = Number(await readState(sdk, contractIndex, 'reserveA')) * Number(await readState(sdk, contractIndex, 'reserveB'));

        const built = await sdk.batch()
            .deposit({ contractActionIndex: contractIndex, tick: tokenA, quantity: SWAP_IN })
            .execute({ contractActionIndex: contractIndex, method: 'swap', params: [tokenA, '0'] })
            .build();

        const res = await submit(sdk,
            { action: 'BATCH', params: { command: built.fields.COMMAND } },
            { pubkey: lp.address, change: lp.address }, submitOpts({ wif: lp.wif }));
        console.log('    [amm] swap status=' + res.indexed.status);
        expect(res.indexed.status, 'swap indexed').to.equal('valid');

        await mine(1);
        const rA = Number(await readState(sdk, contractIndex, 'reserveA'));
        const rB = Number(await readState(sdk, contractIndex, 'reserveB'));
        expect(rA, 'full input retained in reserveA (fee stays in pool)').to.equal(LIQ + SWAP_IN);
        const kAfter = rA * rB;
        console.log('    [amm] k before=' + kBefore + ' after=' + kAfter + ' (delta=' + (kAfter - kBefore) + ')');
        expect(kAfter, 'k is non-decreasing across the swap').to.be.greaterThan(kBefore - 1e-6);
        expect(await waitForBalance(sdk, lp.address, tokenB, (v) => v > 0), 'swapper received tokenB').to.be.greaterThan(0);
    });

    it('removeLiquidity (BATCH: DEPOSIT LP, EXECUTE) burns shares and returns both reserves', async function () {
        const shares = await waitForBalance(sdk, lp.address, lpTick, LIQ);
        expect(shares, 'provider has LP shares to redeem').to.equal(LIQ);

        const built = await sdk.batch()
            .deposit({ contractActionIndex: contractIndex, tick: lpTick, quantity: shares })
            .execute({ contractActionIndex: contractIndex, method: 'removeLiquidity', params: [] })
            .build();

        const res = await submit(sdk,
            { action: 'BATCH', params: { command: built.fields.COMMAND } },
            { pubkey: lp.address, change: lp.address }, submitOpts({ wif: lp.wif }));
        console.log('    [amm] removeLiquidity status=' + res.indexed.status);
        expect(res.indexed.status, 'removeLiquidity indexed').to.equal('valid');

        await mine(1);
        expect(Number(await readState(sdk, contractIndex, 'totalShares')), 'all shares burned').to.equal(0);
        expect(await waitForBalance(sdk, lp.address, lpTick, 0), 'LP shares burned').to.equal(0);
        // Provider got the full pool back: reserveA went in at LIQ + the swap's SWAP_IN.
        expect(await waitForBalance(sdk, lp.address, tokenA, LIQ + SWAP_IN), 'provider redeemed tokenA').to.equal(LIQ + SWAP_IN);
    });
});
