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
    expect, cryptoHelper, makeSdk, deployContract, fundedGasAddress, mine, submitOpts,
    uniqueTick, chunkHelper, sourceFor, addressId, contractRows, waitFor, executionRow,
    stateRows, haveConnectors, PAD_2CHUNK, GAS_LIMIT, START,
} = require('./shared.test');

// A normally-ordered deploy of AT1's source, from a different address: the
// reference AT1's out-of-order deploy is compared against.
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

async function initializeReference() {
    state.sdk = makeSdk();
    state.payout = (await cryptoHelper.getNewAddress('chunk-deferred-miner', COIN, NETWORK, null, 'legacy', 0)).address;

    // AT1 asserts the deferred contract's state is byte-identical to the same
    // source deployed the ordinary way. "Inline" is not available to a source
    // that needs chunking at all, so the reference is the SEQUENTIAL path: every
    // carrier confirmed before the assembler, which completes the group from
    // lower carriers and deploys at its own index (R2.1, assembler_action_index
    // NULL). Different address, so it is a different group and cannot interfere.
    state.refRun = uniqueTick('CDR');
    const refSrc = sourceFor(state.refRun, PAD_2CHUNK);
    state.refPlan = chunkHelper.planDeploy(refSrc, { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
    expect(state.refPlan.single, 'reference source must NOT fit a single DEPLOY').to.equal(false);
    expect(state.refPlan.totalChunks, 'reference source plans to 2 chunks').to.equal(2);

    const refDeployer = await fundedGasAddress(state.sdk, 1);
    const res = await deployContract(state.sdk,
        { code: refSrc, gasLimit: GAS_LIMIT, constructorParams: [String(START)] },
        { pubkey: refDeployer.address, change: refDeployer.address },
        submitOpts({ wif: refDeployer.wif }));
    expect(res.indexed.status, 'sequential reference deploy indexed').to.equal('valid');
    await mine(1);

    const refSrcId = await addressId(refDeployer.address);
    const rows = await waitFor(async () => {
        const found = (await contractRows(refSrcId, state.refPlan.codeHash)).filter(r => r.status === 'valid');
        return found.length ? found : null;
    }, 'the sequential reference contract to index valid');
    state.refContractIndex = rows[0].action_index;

    const refExec = await executionRow(state.refContractIndex);
    expect(refExec, 'reference constructor execution row').to.not.equal(null);
    expect(refExec.assembler_action_index,
        'a sequential deploy completes from lower carriers at its own index (R2.1), so nothing was consumed')
        .to.equal(null);
    state.refGasUsed = refExec.gas_used;
    state.refState = await stateRows(state.refContractIndex);
    expect(state.refState.length, 'reference constructor wrote state').to.be.greaterThan(0);

    console.log('    [deferred] reference contract=' + state.refContractIndex + ' hash=' + state.refPlan.codeHash.slice(0, 12) +
                ' gas_used=' + state.refGasUsed + ' state_rows=' + state.refState.length);
}

async function setup() {
    if (!haveConnectors()) this.skip();
    // Raw-hex placement plus an empty competing chain is the BTC/LTC mechanism;
    // DOGE regtest mines on a different model. LTC would exercise the native-fee
    // split, which is AT8's subject in the indexer unit tier, not this file's.
    if (global.COIN_CODE !== 'BTC') this.skip();
    if (!state.sdk) await initializeReference();

    // Auto-mining is held only from HERE, once the reference deploy is on chain.
    // It cannot be held across the reference: that leg goes through submit(),
    // which broadcasts and then waits on the indexer, and the only thing that
    // would confirm it is the auto-miner (submit's quiesce runs BEFORE the
    // broadcast, and deployContract's mine() only after the wait returns). Held
    // from the top, every reference piece timed out at 120s and the hook died.
    // The `it`s below place their own blocks, so the hold starts where the
    // deterministic placement does.
    await pauseMining();
}

module.exports = { state, setup, pauseMining, resumeMining };
