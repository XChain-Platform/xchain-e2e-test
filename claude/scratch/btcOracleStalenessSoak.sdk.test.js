/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * XChain Platform E2E - BTC oracle-price staleness soak
 *
 * Empirical proof for the 2026-06-20 harness fix (commit 01064c7): a BTC
 * contract action that lands AFTER the oracle staleness window
 * (ORACLE_MAX_PRICE_AGE_SECONDS = 1800s) still indexes `valid`, because the
 * per-action throttled re-seed in sdkHelper.submit() / nativeFeeHelper keeps
 * BTC/USD fresh. Pre-fix, the DEPLOY-time snapshot aged out and the late
 * EXECUTE indexed `invalid: no current oracle price for BTC/USD` (the
 * false-red/false-green by timing the campaign hunts for).
 *
 * Run on a live BTC-regtest stack. Set STALE_SLEEP_SECONDS to the gap between
 * DEPLOY and EXECUTE (default 1980s = 33min, comfortably past the 1800s
 * window). Use a small value (e.g. 20) for a plumbing smoke first.
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
        }
    };
`;

const STALENESS_WINDOW = 1800; // ORACLE_MAX_PRICE_AGE_SECONDS (block-time)
const SLEEP_SECONDS = parseInt(process.env.STALE_SLEEP_SECONDS || '1980', 10);

function contractIndexOf(indexed) {
    const a = indexed && Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.action_index : null;
}

describe('[sdk] BTC oracle-price staleness soak (>30min contract run)', function () {
    this.timeout(0);

    let sdk, deployer, contractIndex, deployAtMs;

    before(async function () {
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [soak] deployer=' + deployer.address +
            ' sleep=' + SLEEP_SECONDS + 's window=' + STALENESS_WINDOW + 's');
    });

    it('DEPLOY indexes valid (initial oracle seed)', async function () {
        const res = await submit(sdk,
            { action: 'DEPLOY', params: { code: COUNTER_CONTRACT, gasLimit: 200000, constructorParams: 'initialize' } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(res.indexed.status, 'DEPLOY status').to.equal('valid');
        contractIndex = contractIndexOf(res.indexed);
        expect(contractIndex, 'contract action_index').to.not.equal(null);
        deployAtMs = Date.now();
        console.log('    [soak] DEPLOY valid contractIndex=' + contractIndex +
            ' at ' + new Date(deployAtMs).toISOString());
    });

    it('idles past the ' + STALENESS_WINDOW + 's oracle staleness window', async function () {
        const target = deployAtMs + SLEEP_SECONDS * 1000;
        while (Date.now() < target) {
            await new Promise(r => setTimeout(r, 60000));
            const elapsed = Math.round((Date.now() - deployAtMs) / 1000);
            console.log('    [soak] idled ' + elapsed + 's / ' + SLEEP_SECONDS + 's');
        }
    });

    it('EXECUTE after the window still indexes valid (per-action re-seed kept BTC/USD fresh)', async function () {
        const elapsed = Math.round((Date.now() - deployAtMs) / 1000);
        console.log('    [soak] elapsed since DEPLOY=' + elapsed + 's (window=' + STALENESS_WINDOW + 's)');
        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'increment', params: [] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(res.indexed.status, 'late EXECUTE status').to.equal('valid');
        if (SLEEP_SECONDS > STALENESS_WINDOW) {
            expect(elapsed, 'run must exceed the staleness window to count as a soak')
                .to.be.greaterThan(STALENESS_WINDOW);
        }
    });

    it('contract state reflects the post-window increment', async function () {
        await mine(1);
        const state = await sdk.getContractState(contractIndex, 'count');
        const rows = (state && state.data) || [];
        const row = rows.find(r => r.state_key === 'count');
        expect(row, 'count state row').to.exist;
        expect(String(JSON.parse(row.state_value)), 'count').to.equal('1');
    });
});
