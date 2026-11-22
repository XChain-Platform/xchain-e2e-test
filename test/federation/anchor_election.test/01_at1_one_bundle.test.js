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

const { N, S, bundleKey, rankOrder, nextSeq, insertCheckpointEverywhere, syntheticCheckpoint, bundles } = require('./support/state');
const { waitForAnchorBackfill, waitForTip } = require('./support/waits');

// All three chains at the SAME snapshot_block: the steady state, where the
// bundle's SNAPSHOT_BLOCK (MAX over sections) equals every section's own.
async function seedThreeChains(block){
    for (const chain of ['BTC', 'LTC', 'DOGE']) {
        const row = syntheticCheckpoint(chain, await nextSeq(chain), block);
        S.cpRows.push(row);
        await insertCheckpointEverywhere(row);
    }
}

// Log each hub wallet's UTXO set as the tracker sees it.
async function logWalletUtxos(){
    const axios = require('axios');
    for (let i = 0; i < N; i++) {
        const resp = await axios.post('http://' + (process.env.UTXO_TRACKER_URL || 'localhost') + ':' +
            (process.env.UTXO_TRACKER_API_PORT || '3121') + '/',
            { jsonrpc: '2.0', id: 1, method: 'get_utxos', params: { address: S.wallets[i].address } },
            { timeout: 10000 });
        const utxos = (resp.data.result && resp.data.result.utxos) || [];
        console.log('    hub ' + i + ' wallet ' + S.wallets[i].address + ': ' + utxos.length + ' utxo(s), confs [' +
            utxos.map(u => u.confirmations).join(',') + ']');
    }
}

// ONE bundle, not one per chain. This is the whole point of the rail change:
// the pre-bundle publisher produced three transactions here.
function pickBundle(winner){
    const bs = bundles();
    assert.strictEqual(bs.length, 1,
        'exactly one ANCHOR v0 for the network, got ' + bs.length + ' (' +
        bs.map(b => b.bundle.chains.join('+')).join(' / ') + ')');
    const bundle = bs[0];
    assert.strictEqual(bundle.hub, winner, 'published by the bundle key\'s hash-order rank 0');
    assert.strictEqual(bundle.from, S.wallets[winner].address, 'paid from the winner\'s own wallet');
    assert.ok(bundle.phase1_txid && bundle.phase1_txid !== bundle.txid, 'two-phase publish');
    return bundle;
}

// Three sections, chain-ascending, one per pending chain, all at the
// bundle's own snapshot_block.
function assertSections(bundle, block){
    assert.strictEqual(bundle.bundle.section_count, 3, 'three sections');
    assert.deepStrictEqual(bundle.bundle.chains, ['BTC', 'DOGE', 'LTC'],
        'sections ride CHAIN ascending');
    assert.strictEqual(bundle.bundle.network, 'regtest');
    assert.strictEqual(bundle.bundle.snapshot_block, block, 'header SNAPSHOT_BLOCK is the sections\' MAX');
    for (const s of bundle.bundle.sections) {
        const mine = S.cpRows.find(r => r.chain === s.chain);
        assert.strictEqual(s.checkpoint_seq, mine.checkpoint_seq, s.chain + ': section carries its own seq');
        assert.strictEqual(s.section_snapshot_block, mine.snapshot_block, s.chain + ': section carries its own snapshot block');
        assert.strictEqual(String(s.state_root).toLowerCase(), String(mine.state_root).toLowerCase(),
            s.chain + ': section is root-bearing');
    }
}

// ONE reward for the whole bundle, keyed on the bundle's snapshot block, not
// one per chain. The `anchor_<CHAIN>` types no longer exist.
function assertSingleReward(bundle, block, winner){
    assert.ok(bundle.bundle.attest_sig_count >= 1,
        'the publisher attestation round reached quorum (ATTEST_SIG_COUNT ' +
        bundle.bundle.attest_sig_count + '); without it the anchor still lands but no reward is derived');
    const bundleRewards = S.rewards.filter(r => r.type === 'anchor_bundle' && r.round === block);
    assert.strictEqual(bundleRewards.length, 1, 'exactly one anchor_bundle reward record for this bundle');
    assert.strictEqual(bundleRewards[0].pubkey, S.pubkeys[winner], 'reward credited to the winner');
    for (const chain of ['BTC', 'LTC', 'DOGE'])
        assert.strictEqual(S.rewards.filter(r => r.type === 'anchor_' + chain).length, 0,
            'no per-chain anchor_' + chain + ' reward is written any more');
}

// Every hub holds the SAME txid on ALL THREE section rows (XANC_BUNDLE_DONE
// carries the section list, so a peer stamps the whole set from one message).
async function assertEveryHubStamped(bundle){
    for (const row of S.cpRows) {
        for (let i = 0; i < N; i++) {
            const r = await S.mvh.hubs[i].db.doQuery(
                'SELECT anchor_txid FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ?',
                [row.chain, row.network, row.block_index]);
            assert.ok(r.length === 1 && r[0].anchor_txid, row.chain + ': hub ' + i + ' back-filled via BUNDLE_DONE');
            assert.strictEqual(String(r[0].anchor_txid), bundle.txid, row.chain + ': hub ' + i + ' holds the bundle txid');
        }
    }
}

// Idempotency: with everything back-filled, nobody re-anchors.
async function assertNoDoubleAnchor(){
    const count = S.published.length;
    for (const hub of S.mvh.hubs) {
        const s = await hub.stateAnchorPublisher.flush();
        assert.strictEqual(s.anchored.length, 0);
    }
    assert.strictEqual(S.published.length, count, 'no double-anchoring after back-fill');
}

async function runAt1(){
    const block = await waitForTip(0);
    await seedThreeChains(block);

    const order  = rankOrder('regtest', block);
    const winner = order[0];
    console.log('    bundle key ' + bundleKey('regtest', block) + ' -> rank order hub' + order.join(', hub'));
    await logWalletUtxos();

    // Every hub's flush timer would fire in production; fire them all. Only the
    // bundle key's rank 0 is unlocked, so exactly one of them may spend.
    for (const hub of S.mvh.hubs) await hub.stateAnchorPublisher.flush();
    await waitForAnchorBackfill(S.cpRows, S.mvh.hubs, 30000);

    const bundle = pickBundle(winner);
    assertSections(bundle, block);
    assertSingleReward(bundle, block, winner);
    await assertEveryHubStamped(bundle);
    await assertNoDoubleAnchor();

    console.log('    bundle: hub' + winner + ' [' + bundle.bundle.chains.join(',') + '] @ ' + block +
                ' txid ' + bundle.txid + ' (' + bundle.bundle.attest_sig_count + ' attesting sig(s))');
}

function register(){
    it('AT1: one flush lands ONE v0 bundle carrying all three chains, one election, one anchor_bundle reward, every hub stamped', async function () {
        await runAt1();
    });
}

module.exports = { register };
