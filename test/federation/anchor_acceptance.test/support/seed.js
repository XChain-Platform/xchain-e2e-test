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

const { S, indexerQuery, signedSyntheticCheckpoint, insertCheckpoint } = require('./state');

// Hand-mirror the capability snapshot into the INDEXER DB (what
// hub_db_sync would deliver in a hub-connected deployment) so the
// ANCHOR handler verifies signatures as 'valid' rather than 'unverified'.
async function mirrorIndexerCapabilities(snapBlock){
    const pubkey = S.identity.getPubkeyHex().toLowerCase();
    for (const cap of ['oracle_publish', 'cross_chain']) {
        // The indexer verify is stake-weighted on regtest (activates at
        // genesis) and tallies by DISTINCT source; a blank source FAILS CLOSED.
        // Seed a non-blank source (the validator's own key = its staking source)
        // so the single signer is 100% of stake (3*S > 2*S -> valid).
        await indexerQuery(
            'INSERT INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE amount = VALUES(amount), source = VALUES(source)',
            [snapBlock, cap, pubkey, '1', pubkey]);
    }
    const seeded = await indexerQuery(
        'SELECT capability FROM capability_snapshots WHERE snapshot_block = ?', [snapBlock]);
    console.log('    seeded capability rows @ ' + snapBlock + ': ' + JSON.stringify(seeded.map(r => r.capability)));
    assert.strictEqual(seeded.length, 2, 'capability snapshot rows readable at snapshot block ' + snapBlock);
}

// The test needs BTC/LTC/DOGE checkpoints PENDING at one snapshot block. This
// venue runs a DOGE indexer only, so the other two rides are synthetic rows
// at the SAME snapshot_block, signed by the same seeded validator over the
// hub's own canonical, hence verifiable by the same mirrored oracle_publish
// set. Seqs clear the indexer's per-chain replay guard on a dirty chain.
async function seedSyntheticCheckpoints(snapBlock){
    for (const chain of ['BTC', 'LTC']) {
        const prior = await indexerQuery(
            'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS s FROM anchor_actions WHERE chain = ? AND network = ?',
            [chain, 'regtest']);
        await insertCheckpoint(signedSyntheticCheckpoint(chain, Number(prior[0].s), snapBlock));
    }
}

// Synthetic finalized cross-chain match, signed by the seeded validator
// (gives the v1 archive real content without a second chain).
async function insertSyntheticMatch(snapBlock){
    const m = {
        match_id: S.matchId, snapshot_block: snapBlock, network: 'regtest',
        a_chain: 'DOGE', a_action_index: 11, a_kind: 'swap', a_tick: 'TOKA', a_amount: '1000',
        a_filled_before: '0', a_ownership: 0, a_payout_addr: 'acceptance_payout_a',
        b_chain: 'LTC', b_action_index: 22, b_kind: 'swap', b_tick: 'TOKB', b_amount: '2000',
        b_filled_before: '0', b_ownership: 0, b_payout_addr: 'acceptance_payout_b',
        effective_time: Math.floor(Date.now() / 1000)
    };
    const canonical = S.hub.crossChainDex.canonicalMatch(m);
    const sigs = JSON.stringify([{ pubkey: S.identity.getPubkeyHex().toLowerCase(), sig: S.identity.sign(canonical) }]);
    await S.hub.db.doQuery(
        `INSERT INTO cross_chain_matches
            (match_id, snapshot_block, network, a_chain, a_action_index, a_kind, a_tick, a_amount,
             a_filled_before, a_ownership, a_payout_addr, b_chain, b_action_index, b_kind, b_tick,
             b_amount, b_filled_before, b_ownership, b_payout_addr, effective_time,
             validator_signatures, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'finalized')`,
        [m.match_id, m.snapshot_block, m.network, m.a_chain, m.a_action_index, m.a_kind, m.a_tick,
         m.a_amount, m.a_filled_before, m.a_ownership, m.a_payout_addr, m.b_chain, m.b_action_index,
         m.b_kind, m.b_tick, m.b_amount, m.b_filled_before, m.b_ownership, m.b_payout_addr,
         m.effective_time, sigs]);
}

// Persist cross_chain AND oracle_publish into the HUB's own local
// capability_snapshots: what CrossChainDexConsensus.broadcastPropose
// persists for cross_chain when a real match finalizes (the synthetic
// match here bypassed the engine), extended to oracle_publish too.
// Without an oracle_publish row here, the publisher-attestation round has
// no quorum to reach and the bundle lands with ATTEST_SIG_COUNT 0, which
// carries no attestation and creates no reward row. A blank `source` would
// also fail the stake-weighted tally closed, so it's set to the validator's
// own key (its staking source), matching the indexer-side seed above.
//
// NOTE: this is a belt-and-suspenders mirror, not the load-bearing fix --
// seedWeightSnapshot's monkeypatch on hub.capabilitySnapshot already makes
// both capabilities resolve correctly straight through the live method
// (getWeightSnapshot), never touching this table. It's kept for any path
// that reads capability_snapshots directly (recovery) rather than through
// resolveCapabilitySet/getActiveOraclePublishPubkeys.
async function mirrorHubCapabilities(snapBlock){
    const pubkey = S.identity.getPubkeyHex().toLowerCase();
    for (const cap of ['cross_chain', 'oracle_publish']) {
        await S.hub.db.doQuery(
            'INSERT IGNORE INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?)',
            [snapBlock, cap, pubkey, '1', pubkey]);
    }
}

module.exports = { mirrorIndexerCapabilities, seedSyntheticCheckpoints, insertSyntheticMatch, mirrorHubCapabilities };
