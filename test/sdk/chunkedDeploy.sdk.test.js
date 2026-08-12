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
 * XChain Platform E2E - Chunked DEPLOY (large contract) on-chain
 *
 * Proves a contract whose base64 source exceeds the single-action size cap
 * deploys across multiple DEPLOY v4 carrier actions + an assembling DEPLOY v2, then
 * runs through the live regtest pipeline (encoder → decoder → indexer → VM).
 *
 *   - chunkHelper.planDeploy splits base64(code) into ordered slices + a CODE_HASH
 *   - each slice is uploaded as a DEPLOY v4 carrier (confirmed in turn)
 *   - a DEPLOY v2 carrying CODE_HASH assembles + sha256-verifies + deploys
 *   - the constructor state proves the reassembled source is byte-exact
 *   - an EXECUTE proves the assembled contract actually runs
 *
 * Run (host with regtest stack + Node 22):
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');
const { chunkHelper } = require('xchain-sdk');

// A contract too large for a single DEPLOY: a ~7 KB string literal pads the source
// past the base64 single-action budget, forcing ≥2 chunks. The string survives
// (it is code, not a comment) and is otherwise unused; `increment` proves the
// reassembled contract runs. No xchain.* calls in module scope, so readManifest
// is clean and the constructor initializes state.
const PAD = 'x'.repeat(7000);
const SRC = [
    'var PAD = "' + PAD + '";',
    'module.exports = {',
    '  initialize: function (xchain) {',
    '    var start = xchain.getInputParam(0);',
    '    xchain.state.set("count", String(parseInt(start) || 0));',
    '    xchain.state.set("padlen", String(PAD.length));',
    '  },',
    '  increment: function() {',
    '    xchain.state.set("count", String(parseInt(xchain.state.get("count")) + 1));',
    '  }',
    '};'
].join('\n');

const GAS_LIMIT = 400000;
const START     = 5;

function contractIndexOf(indexed) {
    const list = indexed && Array.isArray(indexed.actions) ? indexed.actions : [];
    const deploy = list.find(a => (a.action === 'DEPLOY')) || list[0] || null;
    return deploy ? deploy.action_index : null;
}

async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    return row ? JSON.parse(row.state_value) : undefined;
}

function haveConnectors() {
    return global.regtestMinerConnector && global.utxoTrackerConnector && global.nodeConnector;
}

describe('[sdk] chunked DEPLOY (large contract assembled from DEPLOY v4 carriers)', function () {
    this.timeout(0);

    let sdk, deployer, plan, contractIndex;

    before(async function () {
        if (!haveConnectors()) this.skip();
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);

        // Plan must require chunking, or this test proves nothing.
        plan = chunkHelper.planDeploy(SRC, { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.single, 'source must NOT fit a single DEPLOY (else not testing chunking)').to.equal(false);
        expect(plan.totalChunks, 'expected ≥2 chunks').to.be.greaterThan(1);

        console.log('    [chunked] deployer=' + deployer.address);
        console.log('    [chunked] source=' + Buffer.byteLength(SRC, 'utf8') + ' B → ' + plan.totalChunks + ' chunks, hash=' + plan.codeHash.slice(0, 12));
    });

    it('uploads each base64 slice as a DEPLOY v4 carrier', async function () {
        for (let i = 0; i < plan.parts.length; i++) {
            const res = await submit(sdk,
                { action: 'DEPLOY', params: { version: '4', codeHash: plan.codeHash, chunkIndex: i, totalChunks: plan.totalChunks, codePart: plan.parts[i] } },
                { pubkey: deployer.address, change: deployer.address },
                submitOpts({ wif: deployer.wif }));
            expect(res.indexed.status, 'DEPLOY v4 carrier ' + i + ' indexed').to.equal('valid');
            await mine(1);
        }
    });

    it('assembles the contract via DEPLOY v2 (CODE_HASH) and runs the constructor', async function () {
        const res = await submit(sdk,
            { action: 'DEPLOY', params: { version: '2', codeHash: plan.codeHash, gasLimit: GAS_LIMIT, constructorParams: [String(START)] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif }));
        console.log('    [chunked] DEPLOY v2 status=' + res.indexed.status);
        expect(res.indexed.status, 'assembling DEPLOY v2 indexed').to.equal('valid');
        contractIndex = contractIndexOf(res.indexed);
        expect(contractIndex, 'contract action_index').to.not.equal(null);

        await mine(1);
        // Constructor state proves the reassembled source is byte-exact: padlen must equal
        // the original PAD length, and count seeded to START.
        expect(await readState(sdk, contractIndex, 'padlen'), 'padlen matches the reassembled source').to.equal(String(PAD.length));
        expect(await readState(sdk, contractIndex, 'count'), 'count seeded to START').to.equal(String(START));
        console.log('    [chunked] contractIndex=' + contractIndex);
    });

    it('EXECUTEs a method on the assembled contract (proves it runs)', async function () {
        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'increment', params: [] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif }));
        expect(res.indexed.status, 'EXECUTE increment indexed').to.equal('valid');

        await mine(1);
        expect(await readState(sdk, contractIndex, 'count'), 'increment advanced the counter').to.equal(String(START + 1));
    });

    it('rejects an assembling DEPLOY whose CODE_HASH does not match any chunks', async function () {
        // A hash with no uploaded chunks must fail assembly deterministically.
        const bogus = 'f'.repeat(64);
        const res = await submit(sdk,
            { action: 'DEPLOY', params: { version: '2', codeHash: bogus, gasLimit: GAS_LIMIT, constructorParams: [] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif, requireValid: false }));
        await mine(1);
        expect(String(res.indexed.status), 'unmatched CODE_HASH rejected').to.contain('CODE_HASH');
    });
});
