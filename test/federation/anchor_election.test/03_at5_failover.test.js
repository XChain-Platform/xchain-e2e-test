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

const { S, rankOrder, indexerQuery, insertCheckpointEverywhere, syntheticCheckpoint, bundles } = require('./support/state');
const { waitForBundleIndexed, waitForTip } = require('./support/waits');

// A fresh single-chain bundle so the failover has something pending. BTC's
// previous seq came from the AT3 pair.
async function seedPendingBtc(block){
    const prevSeq = (await indexerQuery(
        "SELECT COALESCE(MAX(checkpoint_seq), -1) AS s FROM anchor_actions WHERE chain = 'BTC' AND network = 'regtest'"))[0].s;
    const row = syntheticCheckpoint('BTC', Number(prevSeq) + 1, block);
    await insertCheckpointEverywhere(row);
    return row;
}

// Inside the window (since ~ 0) every rank but 0 is locked; once the window
// elapses without rank 0 (it never flushes) rank 1 unlocks and publishes.
async function failOverToRankOne(order, block, row){
    for (const hub of S.mvh.hubs) hub.stateAnchorPublisher.electionToleranceBlocks = 2;
    const before = bundles().length;
    for (const r of order.slice(1)) await S.mvh.hubs[r].stateAnchorPublisher.flush();
    assert.strictEqual(bundles().length, before, 'higher ranks locked inside the tolerance window');

    await regtestMinerConnector.generateBlocks(3);
    await waitForTip(block + 3);
    await S.mvh.hubs[order[1]].stateAnchorPublisher.flush();
    const failover = bundles().slice(before);
    assert.strictEqual(failover.length, 1, 'rank 1 published the failover bundle');
    assert.strictEqual(failover[0].hub, order[1]);
    assert.strictEqual(failover[0].from, S.wallets[order[1]].address, 'failover paid from rank 1\'s wallet');
    assert.deepStrictEqual(failover[0].bundle.chains, [row.chain]);
    return failover[0];
}

// BYTE DETERMINISM: rank 0 rebuilds the same bundle from ITS OWN rows and
// must produce the same bytes rank 1 put on the wire. parseSigs returns the
// stored JSON order unsorted, so without the inner PUBKEY sort two publishers
// racing this bundle emit different bytes and the attestation round's DB
// byte-match stops being deterministic.
async function assertByteIdenticalRebuild(order, row, failover){
    const mineRank0 = await S.mvh.hubs[order[0]].db.doQuery(
        'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND checkpoint_seq = ?',
        [row.chain, row.network, row.checkpoint_seq]);
    const rebuilt = S.mvh.hubs[order[0]].stateAnchorPublisher.buildV7Payload(
        mineRank0, S.pubkeys[order[1]], failover.bundle.attestSigs);
    assert.strictEqual(rebuilt, failover.payload,
        'rank 0 rebuilds byte-identical bundle bytes for the same state');
}

// Rank 0 "comes back" having MISSED the announcement: clear its stamp so the
// back-fill cannot be what saves it, and make it flush. The only thing left to
// stop a second spend is findExistingBundle's per-section getanchoraction
// against the mined transaction, which is exactly what AT5 asserts.
async function assertReturningRankZeroAdopts(order, row, failover){
    assert.ok(await waitForBundleIndexed([row], 120000),
        'the DOGE indexer parsed and stored the failover bundle\'s section row');
    await S.mvh.hubs[order[0]].db.doQuery(
        'UPDATE state_checkpoints SET anchor_txid = NULL WHERE chain = ? AND network = ? AND checkpoint_seq = ?',
        [row.chain, row.network, row.checkpoint_seq]);

    const count = bundles().length;
    const s = await S.mvh.hubs[order[0]].stateAnchorPublisher.flush();
    assert.strictEqual(bundles().length, count, 'returning rank 0 did NOT spend a second time');
    // The adopt path stamps the row with the txid it found on chain rather than
    // leaving it pending, so the fleet converges on one txid.
    const after = await S.mvh.hubs[order[0]].db.doQuery(
        'SELECT anchor_txid FROM state_checkpoints WHERE chain = ? AND network = ? AND checkpoint_seq = ?',
        [row.chain, row.network, row.checkpoint_seq]);
    assert.strictEqual(String(after[0].anchor_txid).toLowerCase(), String(failover.txid).toLowerCase(),
        'rank 0 adopted rank 1\'s txid through the per-section lookup');
    assert.ok(Array.isArray(s.anchored), 'flush returned a summary');
}

async function runAt5(){
    const block = await waitForTip(0);
    const row   = await seedPendingBtc(block);
    const order = rankOrder('regtest', block);
    const failover = await failOverToRankOne(order, block, row);
    await assertByteIdenticalRebuild(order, row, failover);
    await assertReturningRankZeroAdopts(order, row, failover);
    console.log('    AT5: rank1 hub' + order[1] + ' published ' + failover.txid +
                '; rank0 hub' + order[0] + ' adopted it without spending');
}

function register(){
    it('AT5: ranks stay locked in-window, rank 1 takes over, and a returning rank 0 adopts by per-section lookup with no second spend', async function () {
        await runAt5();
    });
}

module.exports = { register };
