/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const assert = require('assert');

const { S, insertCheckpointEverywhere, syntheticCheckpoint, bundles } = require('./support/state');
const { waitForAnchorBackfill, waitForTip } = require('./support/waits');

// BTC and DOGE cut a new checkpoint and LTC does not (on the venue: its indexer
// is stopped, so no new row is cut at all). LTC's MAX un-anchored seq does not
// exist, so it is absent - and that is the NORMAL daily case, never a reason to
// hold the bundle.
async function flushShortBundle(block){
    const pair = [];
    for (const chain of ['BTC', 'DOGE']) {
        const prev = S.cpRows.find(r => r.chain === chain);
        const row  = syntheticCheckpoint(chain, prev.checkpoint_seq + 1, block);
        pair.push(row);
        await insertCheckpointEverywhere(row);
    }
    const before = bundles().length;
    for (const hub of S.mvh.hubs) await hub.stateAnchorPublisher.flush();
    await waitForAnchorBackfill(pair, S.mvh.hubs, 30000);

    const fresh = bundles().slice(before);
    assert.strictEqual(fresh.length, 1, 'the short bundle published, exactly once');
    assert.strictEqual(fresh[0].bundle.section_count, 2, 'TWO sections: LTC has nothing new to anchor');
    assert.deepStrictEqual(fresh[0].bundle.chains, ['BTC', 'DOGE'], 'still chain-ascending');
    assert.strictEqual(fresh[0].bundle.snapshot_block, block);
    return fresh[0];
}

// LTC rejoins the moment it cuts a newer un-anchored seq. Nothing had to be
// reset or replayed: the selector picks it up on the next cycle.
async function flushRejoinBundle(block){
    const ltcPrev = S.cpRows.find(r => r.chain === 'LTC');
    const ltcNew  = syntheticCheckpoint('LTC', ltcPrev.checkpoint_seq + 1, block);
    await insertCheckpointEverywhere(ltcNew);

    const before = bundles().length;
    for (const hub of S.mvh.hubs) await hub.stateAnchorPublisher.flush();
    await waitForAnchorBackfill([ltcNew], S.mvh.hubs, 30000);

    const rejoin = bundles().slice(before);
    assert.strictEqual(rejoin.length, 1, 'the catch-up bundle published, exactly once');
    assert.deepStrictEqual(rejoin[0].bundle.chains, ['LTC'],
        'LTC alone: BTC and DOGE were anchored by the short bundle above');
    assert.strictEqual(rejoin[0].bundle.sections[0].checkpoint_seq, ltcNew.checkpoint_seq,
        'LTC rejoined at its NEWER seq, not the one already on chain');
    return { bundle: rejoin[0], seq: ltcNew.checkpoint_seq };
}

async function runAt3(){
    // AT1 anchored all three; the short bundle and the rejoin follow from there.
    const block = await waitForTip(0);
    const short = await flushShortBundle(block);
    const rejoin = await flushRejoinBundle(block);
    console.log('    AT3: [' + short.bundle.chains.join(',') + '] then [' +
                rejoin.bundle.bundle.chains.join(',') + '] at seq ' + rejoin.seq);
}

function register(){
    it('AT3: a chain whose newest eligible checkpoint is already anchored is ABSENT, the bundle is short, and it rejoins at its newer seq', async function () {
        await runAt3();
    });
}

module.exports = { register };
