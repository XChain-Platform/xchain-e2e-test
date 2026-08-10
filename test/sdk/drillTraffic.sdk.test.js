/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

/*********************************************************************
 *
 * Flag-day transition drill traffic (venue-local, NOT for CI).
 *
 * Drives real SDK actions across three activation boundaries on a
 * regtest stack whose DRILL indexers carry future-valued gate maps:
 *   C_H  - state-commitment + state-hash classes (local height)
 *   B_H  - BTC-anchored validator-era gates (snapshot height)
 *   A_TS - contract-era block_TIME cohort (wall clock)
 * The standing stack indexer stays genesis-active and is what confirms
 * these actions; the drill indexers replay the same chain under the
 * armed maps. Assertions live in the companion drill-verify script;
 * this file only produces traffic and records what it did.
 *
 ********************************************************************/

const { expect } = require('chai');
const fs = require('fs');
const { makeSdk, submit, fundedGasAddress, mine, uniqueTick, submitOpts } = require('./sdkHelper');

const C_H  = parseInt(process.env.DRILL_C_H || '0');
const B_H  = parseInt(process.env.DRILL_B_H || '0');
const A_TS = parseInt(process.env.DRILL_A_TS || '0');
const OUT  = process.env.DRILL_OUT || process.env.HOME + '/drill/traffic.json';

const SYNC_CONTRACT = `
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

// Async body: rejected by the deploy validator wherever VM_BANNED_ASYNC is
// active, accepted (and Promise-runnable) where it is not yet active.
const ASYNC_CONTRACT = `
    module.exports = {
        initialize: async function() {
            xchain.state.set('x', '1');
        }
    };
`;

const rec = { C_H, B_H, A_TS, actions: [] };
function note(label, res) {
    rec.actions.push({
        label,
        txid: res && (res.txid || res.tx_hash || null),
        block: res && res.indexed && (res.indexed.block_index || res.indexed.BLOCK_INDEX) || null,
        status: res && res.indexed && res.indexed.status || null,
    });
    fs.writeFileSync(OUT, JSON.stringify(rec, null, 2));
}

async function tip() { return await global.nodeConnector.getBlockCount(); }
async function mineTo(h) {
    let cur = await tip();
    while (cur < h) { await mine(Math.min(h - cur, 25)); cur = await tip(); }
    return cur;
}

describe('[drill] flag-day transition traffic', function () {
    this.timeout(0);

    let sdk, issuer, tick;

    before(async function () {
        expect(C_H, 'DRILL_C_H env').to.be.above(0);
        expect(B_H, 'DRILL_B_H env').to.be.above(C_H);
        expect(A_TS, 'DRILL_A_TS env').to.be.above(1700000000);
        sdk = makeSdk();
        issuer = await fundedGasAddress(sdk, 2);
        tick = uniqueTick('DRL');
        rec.tick = tick; rec.issuer = issuer.address;
        console.log('    [drill] issuer=' + issuer.address + ' tick=' + tick + ' tip=' + await tip());
    });

    it('P1 pre-C: ISSUE + SEND + sync DEPLOY + async DEPLOY broadcast', async function () {
        expect(await tip(), 'tip must sit below C_H at drill start').to.be.below(C_H - 2);
        let r = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'flagday drill', mintSupply: 1000 } },
            { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
        expect(r.indexed.status).to.equal('valid'); note('P1.ISSUE', r);

        r = await submit(sdk,
            { action: 'SEND', params: { tick, amount: 10, destination: issuer.address } },
            { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
        expect(r.indexed.status).to.equal('valid'); note('P1.SEND', r);

        r = await submit(sdk,
            { action: 'DEPLOY', params: { code: SYNC_CONTRACT, gasLimit: 200000, constructorParams: 'initialize' } },
            { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
        expect(r.indexed.status).to.equal('valid'); note('P1.DEPLOY_SYNC', r);

        // Broadcast the async deploy WITHOUT waiting for a verdict: the standing
        // indexer (genesis-active ban) rejects it; the drill indexers accept it
        // pre-A_TS. The verify script reads both verdicts from the DBs.
        r = await submit(sdk,
            { action: 'DEPLOY', params: { code: ASYNC_CONTRACT, gasLimit: 200000, constructorParams: 'initialize' } },
            { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif, waitForIndexer: false }));
        note('P1.DEPLOY_ASYNC_PRE_A', r);
        await mine(2);
        console.log('    [drill] P1 done at tip=' + await tip());
    });

    it('P2 cross C_H with supply-changing traffic', async function () {
        await mineTo(C_H - 1);
        // MINTs on both sides of the boundary: supply refreshes are exactly what
        // the token_supply state-hash class folds in at/after C_H.
        for (let i = 0; i < 4; i++) {
            const r = await submit(sdk,
                { action: 'MINT', params: { tick, amount: 100 + i, destination: issuer.address } },
                { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
            expect(r.indexed.status).to.equal('valid'); note('P2.MINT_' + i, r);
        }
        const t = await tip();
        expect(t, 'C boundary must be crossed with MINT traffic').to.be.least(C_H);
        console.log('    [drill] P2 done at tip=' + t);
    });

    it('P3 cross B_H with traffic', async function () {
        await mineTo(B_H - 2);
        for (let i = 0; i < 3; i++) {
            const r = await submit(sdk,
                { action: 'MINT', params: { tick, amount: 200 + i, destination: issuer.address } },
                { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
            expect(r.indexed.status).to.equal('valid'); note('P3.MINT_' + i, r);
        }
        await mineTo(B_H + 4);
        console.log('    [drill] P3 done at tip=' + await tip());
    });

    it('P4 wait for A_TS, then post-A VM traffic', async function () {
        const wait = (A_TS + 3) * 1000 - Date.now();
        if (wait > 0) {
            console.log('    [drill] waiting ' + Math.ceil(wait / 1000) + 's for A_TS wall clock');
            await new Promise(res => setTimeout(res, wait));
        }
        await mine(1); // first block whose timestamp lies at/after A_TS

        let r = await submit(sdk,
            { action: 'DEPLOY', params: { code: SYNC_CONTRACT, gasLimit: 200000, constructorParams: 'initialize' } },
            { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
        expect(r.indexed.status).to.equal('valid'); note('P4.DEPLOY_SYNC_POST_A', r);

        r = await submit(sdk,
            { action: 'DEPLOY', params: { code: ASYNC_CONTRACT, gasLimit: 200000, constructorParams: 'initialize' } },
            { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif, waitForIndexer: false }));
        note('P4.DEPLOY_ASYNC_POST_A', r);
        await mine(2);

        r = await submit(sdk,
            { action: 'MINT', params: { tick, amount: 300, destination: issuer.address } },
            { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
        expect(r.indexed.status).to.equal('valid'); note('P4.MINT', r);
        await mine(3);
        console.log('    [drill] P4 done at tip=' + await tip());
        fs.writeFileSync(OUT, JSON.stringify(rec, null, 2));
    });
});
