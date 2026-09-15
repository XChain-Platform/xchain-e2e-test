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
 ********************************************************************/

'use strict';

const {
    expect, cryptoHelper, makeSdk, fundedGasAddress, chunkHelper, haveConnectors,
    SRC, GAS_LIMIT, START,
} = require('./shared.test');

// Raw hex of every tx this drill is about to orphan: flat (for accounting) and grouped
// per original block in original position (for the ordered replay that closes leg 2),
// plus the subset the drill itself broadcast (which MUST come back).
const state = { miningPaused: false };

async function pauseMining() {
    await global.regtestMinerConnector.pauseMining();
    state.miningPaused = true;
}

async function resumeMining() {
    if (!state.miningPaused) return;
    state.miningPaused = false;
    try { await global.regtestMinerConnector.resumeMining(); } catch (e) { /* best effort */ }
}

async function setup() {
    if (!haveConnectors()) this.skip();
    // Reorg via an empty competing chain is a BTC/LTC mechanism; DOGE regtest uses a
    // different (fast-chain) mining model. Skip it, as reorgBalances.test.js does.
    if (global.COIN_CODE === 'DOGE') this.skip();
    if (state.sdk) return;

    state.sdk = makeSdk();
    // Funded + gas-minted with the auto-miner still running: only the DEPLOY window
    // below has to be block-budgeted.
    state.deployer = await fundedGasAddress(state.sdk, 1);
    const plan = chunkHelper.planDeploy(SRC, { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
    state.plan = plan;
    expect(plan.single, 'source must NOT fit a single DEPLOY (else not testing chunking)').to.equal(false);
    expect(plan.totalChunks, 'expected >=2 chunks').to.be.greaterThan(1);
    state.codeHash = plan.codeHash;
    state.ownTxids = new Set();
    state.orphanedTxs = [];
    state.orphanedBlocks = [];
    state.ownOrphanedTxids = [];
    console.log('    [chunk-reorg] deployer=' + state.deployer.address +
                ' source=' + Buffer.byteLength(SRC, 'utf8') + ' B -> ' + state.plan.totalChunks +
                ' chunks, hash=' + state.codeHash.slice(0, 12) + ' run=' + require('./shared.test').RUN);
}

async function payout() {
    if (!state.payout) {
        state.payout = (await cryptoHelper.getNewAddress('chunk-reorg-miner', COIN, NETWORK, null, 'legacy', 0)).address;
    }
    return state.payout;
}

module.exports = { state, setup, pauseMining, resumeMining, payout };
