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
const crypto = require('crypto');

const { S, N } = require('./state');

async function indexerQuery(sql, params){
    const conn = await indexerDatabase.getConnection();
    try { return await conn.query(sql, params); }
    finally { await conn.release(); }
}

async function allHubs(sql, params){
    for (const hub of S.mvh.hubs) await hub.db.doQuery(sql, params);
}

// A DOGE checkpoint row signed by BOTH validators over the hub's OWN
// canonical. Root-bearing by construction: the publisher SKIPS a checkpoint row
// with null roots with a log line rather than emitting a rootless section (D8),
// so a rootless filler would simply be absent and every assert below would misread.
function signedCheckpoint(chain, seq){
    const row = {
        chain, network: 'regtest', block_index: 100000 + seq,
        block_hash:    crypto.randomBytes(32).toString('hex'),
        ledger_hash:   crypto.randomBytes(32).toString('hex'),
        actions_hash:  crypto.randomBytes(32).toString('hex'),
        contract_hash: crypto.randomBytes(32).toString('hex'),
        checkpoint_seq: seq, snapshot_block: S.snapshotBlock,
        state_root:           crypto.randomBytes(32).toString('hex'),
        state_root_version:   1,
        block_merkle_root:    crypto.randomBytes(32).toString('hex'),
        block_merkle_version: 1
    };
    row.validator_signatures = JSON.stringify(S.identities.map(id => ({
        pubkey: id.getPubkeyHex().toLowerCase(),
        sig:    id.sign(S.SCE.canonicalCheckpoint(row))
    })));
    return row;
}

// Seqs must clear the indexer's per-chain replay guard: the regtest chain is
// dirty with earlier runs' anchors while these hub DBs are brand new.
async function nextSeq(chain){
    const r = await indexerQuery(
        'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS s FROM anchor_actions WHERE chain = ? AND network = ?',
        [chain, 'regtest']);
    return Number(r[0].s);
}

// The checkpoint seq for the next cycle: past BOTH the indexer's on-chain
// watermark and the hubs' own newest row.
//
// The indexer half clears the per-chain replay guard on a dirty regtest chain.
// The LOCAL half is what makes a second cycle work at all: an archive-only cycle
// publishes no v0, so the indexer never learns a newer checkpoint_seq and the
// indexer half alone hands back the SAME seq it did last cycle. The duplicate row
// is then swallowed by INSERT IGNORE, the wrapper silently stays the previous
// cycle's checkpoint, and every later lookup keyed on this cycle's ledger_hash
// hunts an anchor that was never built from it.
async function nextCheckpointSeq(chain){
    const onChain = await nextSeq(chain);
    const local   = await S.mvh.hubs[0].db.doQuery(
        'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS s FROM state_checkpoints WHERE chain = ? AND network = ?',
        [chain, 'regtest']);
    return Math.max(onChain, Number(local[0].s));
}

async function insertCheckpointEverywhere(row){
    await allHubs(
        'INSERT IGNORE INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, ' +
        'actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures, ' +
        'state_root, state_root_version, block_merkle_root, block_merkle_version) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [row.chain, row.network, row.block_index, row.block_hash, row.ledger_hash,
         row.actions_hash, row.contract_hash, row.checkpoint_seq, row.snapshot_block,
         row.validator_signatures, row.state_root, row.state_root_version,
         row.block_merkle_root, row.block_merkle_version]);

    // INSERT IGNORE swallows a duplicate, so prove THIS row is the one every hub
    // now holds at that seq. A swallowed insert leaves the previous cycle's
    // checkpoint as the wrapper while every assertion downstream keys on this
    // cycle's ledger_hash, which fails far from the cause.
    for (let i = 0; i < N; i++) {
        const got = await S.mvh.hubs[i].db.doQuery(
            'SELECT ledger_hash FROM state_checkpoints WHERE chain = ? AND network = ? AND checkpoint_seq = ?',
            [row.chain, row.network, row.checkpoint_seq]);
        assert.strictEqual(got.length, 1,
            'hub' + i + ': exactly one ' + row.chain + ' checkpoint at seq ' + row.checkpoint_seq);
        assert.strictEqual(String(got[0].ledger_hash), String(row.ledger_hash),
            'hub' + i + ': the checkpoint at seq ' + row.checkpoint_seq + ' is THIS cycle\'s row, not an ' +
            'earlier one an INSERT IGNORE preserved');
    }
}

// A finalized cross-chain match, signed by BOTH validators (a follower
// re-verifies the archived matches against its own rows, and the weighted tally
// needs both sources), inserted identically on every hub. This is the archive's
// cargo: without a pending row there is no batch to archive at all.
async function insertMatchEverywhere(matchId){
    const m = {
        match_id: matchId, snapshot_block: S.snapshotBlock, network: 'regtest',
        a_chain: 'DOGE', a_action_index: 11, a_kind: 'swap', a_tick: 'TOKA', a_amount: '1000',
        a_filled_before: '0', a_ownership: 0, a_payout_addr: 'degraded_payout_a',
        b_chain: 'LTC', b_action_index: 22, b_kind: 'swap', b_tick: 'TOKB', b_amount: '2000',
        b_filled_before: '0', b_ownership: 0, b_payout_addr: 'degraded_payout_b',
        effective_time: Math.floor(Date.now() / 1000)
    };
    const canonical = S.mvh.hubs[0].getCrossChainDex().canonicalMatch(m);
    const sigs = JSON.stringify(S.identities.map(id =>
        ({ pubkey: id.getPubkeyHex().toLowerCase(), sig: id.sign(canonical) })));
    await allHubs(
        `INSERT INTO cross_chain_matches
            (match_id, snapshot_block, network, a_chain, a_action_index, a_kind, a_tick, a_amount,
             a_filled_before, a_ownership, a_payout_addr, b_chain, b_action_index, b_kind, b_tick,
             b_amount, b_filled_before, b_ownership, b_payout_addr, effective_time,
             validator_signatures, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'finalized')`,
        [m.match_id, m.snapshot_block, m.network, m.a_chain, m.a_action_index, m.a_kind, m.a_tick,
         m.a_amount, m.a_filled_before, m.a_ownership, m.a_payout_addr, m.b_chain, m.b_action_index,
         m.b_kind, m.b_tick, m.b_amount, m.b_filled_before, m.b_ownership, m.b_payout_addr,
         m.effective_time, sigs]);

    // Prove the seed is genuinely UNBATCHED on every hub, at the moment it is
    // written. The archive selector's pending test is
    // `batch_seq IS NULL OR archived_status <> status`, so a row that somehow
    // landed already stamped is invisible to the round and the cycle flushes an
    // empty pipeline, which surfaces minutes later as an unexplained 'none'. Both
    // columns are nullable with no default (xchain-hub src/sql/cross_chain_matches.sql),
    // so this should always hold; it is asserted because the failure mode it
    // guards is one that reads as an election fault.
    for (let i = 0; i < N; i++) {
        const rows = await S.mvh.hubs[i].db.doQuery(
            'SELECT batch_seq FROM cross_chain_matches WHERE match_id = ?', [matchId]);
        assert.strictEqual(rows.length, 1, 'hub' + i + ': the seeded match landed');
        assert.ok(rows[0].batch_seq === null || rows[0].batch_seq === undefined,
            'hub' + i + ': the seeded match is unbatched, so the archive round can pick it up (batch_seq ' +
            rows[0].batch_seq + ')');
    }
    return m;
}

// The archive pipeline as startArchiveRound sees it: its three pending selectors,
// run verbatim against one hub.
//
// With matches, calls and rewards ALL empty the round returns 'none' (spec §1) no
// matter how clean the election was, and nothing outside the hub shows why. In a
// two-cycle test the first cycle consumes what it seeded, so the second cycle's
// content is a precondition to establish rather than assume: this is what AT-F4's
// recovery cycle failed on with an election that was entirely correct (both hubs
// agreeing on batch 36 and on the leader, nothing in flight).
async function archivePipeline(hubIndex){
    const sap = S.mvh.hubs[hubIndex].stateAnchorPublisher;
    const db  = S.mvh.hubs[hubIndex].db;
    const matches = await db.doQuery(
        'SELECT match_id FROM cross_chain_matches WHERE batch_seq IS NULL OR archived_status <> status ' +
        'ORDER BY match_id ASC LIMIT ?', [sap.maxBatch]);
    const calls = await db.doQuery(
        'SELECT call_id FROM cross_chain_calls WHERE batch_seq IS NULL OR archived_status <> status ' +
        'ORDER BY call_id ASC, phase ASC LIMIT ?', [sap.maxBatch]);
    const rewards = await db.doQuery(
        "SELECT reward_type, round_number, validator_pubkey, block_index FROM validator_rewards " +
        "WHERE reward_type LIKE 'anchor\\_%' AND batch_seq IS NULL AND block_index IS NOT NULL " +
        'ORDER BY reward_type ASC, round_number ASC, validator_pubkey ASC LIMIT ?', [sap.maxBatch]);
    return {
        matches: matches.length,
        calls:   calls.length,
        // The publisher drops chain-derived rewards from the batch (the chain
        // re-derives them), so count what it would actually keep, through its own
        // predicate rather than a copy of the rule.
        rewards: (rewards || []).filter(r => !sap.isChainDerivedReward(r)).length
    };
}

function describePipeline(p){
    return 'pending matches ' + p.matches + ', calls ' + p.calls + ', archivable rewards ' + p.rewards;
}

module.exports = { indexerQuery, allHubs, signedCheckpoint, nextSeq, nextCheckpointSeq, insertCheckpointEverywhere, insertMatchEverywhere, archivePipeline, describePipeline };
