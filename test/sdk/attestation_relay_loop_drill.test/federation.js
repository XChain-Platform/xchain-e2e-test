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
 * Step 3: stake the request's responsible attestation keys and the cross_chain majority.
 ********************************************************************/

'use strict';

const assert = require('assert');
const chainRail = require('../../helpers/chainRail');
const { grindResponsibleKeys } = require('./codec');
const { REDUNDANCY, ATTESTATION_MIN_STAKE, ACTIVATION_DELAY_BLOCKS } = require('./config');
const { indexerRpc, capabilityWeights, waitForIndexedHeight } = require('./rail');
const { stakeKeyFrom } = require('./stakes');

async function stakeAttestKeys(ctx) {
    const rail = ctx.homeRail;
    // The set the responsible-set rule will rank our keys against.
    const tip = (await indexerRpc(rail, 'getlatestblock', {})).block_index;
    const existing = (await capabilityWeights(rail, 'attestation', tip))
        .map(v => String(v.pubkey).toLowerCase());
    console.log('    [relay-loop] existing attestation keys on ' + rail.code + ': ' + existing.length);

    ctx.responsibleValidators = grindResponsibleKeys(ctx.originRequestId, REDUNDANCY, existing);
    for (let i = 0; i < ctx.responsibleValidators.length; i++) {
        const v = ctx.responsibleValidators[i];
        const src = ctx.attestStakeSources[i];
        await stakeKeyFrom(rail, src, ATTESTATION_MIN_STAKE, v.pubkey, 'attestation stake ' + i);
        v.source = src.address;
        console.log('    [relay-loop] attestation key ' + v.pubkey.slice(0, 16) + '... staked from ' + src.address);
    }
}

// Stakes qualify only after ACTIVATION_DELAY_BLOCKS, and the snapshot the
// v3 names has to be a block the indexer has actually committed.
async function resolveSnapshot(ctx) {
    await global.regtestMinerConnector.generateBlocks(ACTIVATION_DELAY_BLOCKS + 1);
    const minedTo = await global.nodeConnector.getBlockCount();
    ctx.snapshotBlock = await waitForIndexedHeight(ctx.homeRail, minedTo);

    const armed = await capabilityWeights(ctx.homeRail, 'cross_chain', ctx.snapshotBlock);
    const mine = armed.filter(v => String(v.pubkey).toLowerCase() === ctx.relaySigner.pubkey);
    assert(mine.length === 1, 'the drill cross_chain key should qualify at the snapshot block');
    const total = new Map();
    for (const v of armed) total.set(String(v.source), Number(v.weight));
    const S = Array.from(total.values()).reduce((a, b) => a + b, 0);
    assert(3 * Number(mine[0].weight) > 2 * S,
        'drill stake must be a >2/3 weighted majority (have ' + mine[0].weight + ' of ' + S + ')');
    console.log('    [relay-loop] snapshot_block=' + ctx.snapshotBlock + ' drill weight=' + mine[0].weight + '/' + S);
}

async function stakeFederation(ctx) {
    await chainRail.withRail(ctx.homeRail, async () => {
        await stakeAttestKeys(ctx);
        // From here until the unstake two steps below, the drill holds the
        // cross_chain stake majority on this chain. Keep that window short.
        await stakeKeyFrom(ctx.homeRail, ctx.relayStakeSource, Number(ctx.relayStakeAmount).toFixed(8),
            ctx.relaySigner.pubkey, 'cross_chain stake');
        ctx.relaySigner.source = ctx.relayStakeSource.address;
        await resolveSnapshot(ctx);
    });
}

module.exports = { stakeFederation };
