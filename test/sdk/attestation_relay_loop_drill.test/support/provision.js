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
 *
 * Step 1: fund the home sources and mint the XCHAIN behind the cross_chain stake.
 ********************************************************************/

'use strict';

const cryptoHelper = require('../../../helpers/core/cryptoHelper');
const gasHelper    = require('../../../helpers/gasHelper');
const chainRail    = require('../../../helpers/chainRail');
const { RelaySigner } = require('./codec');
const { REDUNDANCY, MINT_CHUNK } = require('./config');
const { indexerRpc, capabilityWeights, resilientSend } = require('./rail');

function fundedAddress(rail, label, coins) {
    return cryptoHelper.getNewFundedAddress(
        label + '-' + Date.now(), rail.coin, rail.network, null, 'legacy', 0, coins, false);
}

// One funded source per responsible slot: SWQ source-dedup keeps a single
// slot per source, so same-source keys could never fill the set. The KEYS
// are not known yet (they are ground against the request id), only the
// addresses that will stake them.
async function fundAttestStakers(ctx) {
    for (let i = 0; i < REDUNDANCY; i++) {
        const src = await resilientSend('attestation staker ' + i + ' funding', ctx.homeRail, () =>
            fundedAddress(ctx.homeRail, 'xc974-att-' + i, 0.05));
        await resilientSend('attestation staker ' + i + ' gas', ctx.homeRail, () =>
            gasHelper.ensureGasBalance(src, '3000'));
        ctx.attestStakeSources.push(src);
    }
}

// cross_chain is stake-weighted on regtest and BTC resolves it from LOCAL
// stakes, so the drill needs more than 2/3 of it: 3Y > 2(S+Y) -> Y > 2S.
async function sizeRelayStake(ctx) {
    const tip = (await indexerRpc(ctx.homeRail, 'getlatestblock', {})).block_index;
    const ccWeights = await capabilityWeights(ctx.homeRail, 'cross_chain', tip);
    const bySource = new Map();
    for (const v of ccWeights) bySource.set(String(v.source), Number(v.weight));
    const liveStake = Array.from(bySource.values()).reduce((a, b) => a + b, 0);
    ctx.relayStakeAmount = Math.ceil((2 * liveStake + MINT_CHUNK) / MINT_CHUNK) * MINT_CHUNK;
    console.log('    [relay-loop] live cross_chain stake ' + liveStake + '; drill will stake ' + ctx.relayStakeAmount);
}

async function mintRelayStake(ctx) {
    ctx.relaySigner = new RelaySigner();
    ctx.relayStakeSource = await resilientSend('cross_chain staker funding', ctx.homeRail, () =>
        fundedAddress(ctx.homeRail, 'xc974-cc', 1));
    const chunks = Math.ceil(ctx.relayStakeAmount / MINT_CHUNK);
    const mintStarted = Date.now();
    for (let i = 0; i < chunks; i++) {
        await resilientSend('gas mint ' + (i + 1) + '/' + chunks, ctx.homeRail, () =>
            gasHelper.ensureGasBalance(ctx.relayStakeSource, String(MINT_CHUNK)));
        if ((i + 1) % 5 === 0 || i + 1 === chunks)
            console.log('    [relay-loop] minted ' + ((i + 1) * MINT_CHUNK) + '/' + ctx.relayStakeAmount +
                        ' XCHAIN (' + Math.round((Date.now() - mintStarted) / 1000) + 's)');
    }
}

async function provisionHome(ctx) {
    await chainRail.withRail(ctx.homeRail, async () => {
        ctx.homeOperator = await resilientSend('home operator funding', ctx.homeRail, () =>
            fundedAddress(ctx.homeRail, 'xc974-home-op', 0.2));
        await resilientSend('home gas', ctx.homeRail, () => gasHelper.ensureGasBalance(ctx.homeOperator, '5000'));
        await fundAttestStakers(ctx);
        await sizeRelayStake(ctx);
        await mintRelayStake(ctx);
    });
}

module.exports = { provisionHome };
