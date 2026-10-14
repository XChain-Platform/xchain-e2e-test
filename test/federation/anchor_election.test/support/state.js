/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const crypto = require('crypto');

const anchorVersions = require('../../../helpers/anchorVersionHelper');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = 4;

// The one mutable record the hooks and the tests share.
const S = {
    mvh: null, sdk: null, SAP: null,
    wallets:   [],   // funded addressInfo per hub, hub order
    pubkeys:   [],   // lowercase signing pubkeys, hub order
    published: [],   // { hub, payload, txid, phase1_txid, from }
    rewards:   [],   // { hub, type, round, pubkey }
    cpRows:    []    // synthetic checkpoints of the FIRST bundle
};

// The bundle election key (StateAnchorPublisher.bundleElectionKey): ONE per
// network per cycle, replacing the per-row key. The rank ladder is
// otherwise unchanged, so the same hashOrder answers it.
function bundleKey(network, snapshotBlock){
    return 'XANCV7|' + network + '|' + String(snapshotBlock);
}

function rankOrder(network, snapshotBlock){        // hub indices by election rank
    return S.SAP.hashOrder(bundleKey(network, snapshotBlock), S.pubkeys).map(pk => S.pubkeys.indexOf(pk));
}

async function indexerQuery(sql, params){
    const conn = await indexerDatabase.getConnection();
    try { return await conn.query(sql, params); }
    finally { await conn.release(); }
}

async function allHubs(sql, params){
    for (const hub of S.mvh.hubs) await hub.db.doQuery(sql, params);
}

async function insertCheckpointEverywhere(row){
    await allHubs(
        'INSERT IGNORE INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, ' +
        'actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures, ' +
        'state_root, state_root_version, block_merkle_root, block_merkle_version) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [row.chain, row.network, row.block_index, row.block_hash, row.ledger_hash,
         row.actions_hash, row.contract_hash, row.checkpoint_seq, row.snapshot_block, row.validator_signatures,
         row.state_root, row.state_root_version, row.block_merkle_root, row.block_merkle_version]);
}

// A v0 section is ROOT-BEARING BY CONSTRUCTION: the publisher SKIPS a
// checkpoint row with null roots with a log line rather than emitting a
// rootless wire, so a rootless synthetic row would be silently absent from
// every bundle and every cardinality assert would read as a bug in the
// publisher. Every synthetic row therefore carries all four root fields.
function syntheticCheckpoint(chain, seq, snapshotBlock){
    return {
        chain, network: 'regtest', block_index: 100000 + seq,
        block_hash:    crypto.randomBytes(32).toString('hex'),
        ledger_hash:   crypto.randomBytes(32).toString('hex'),
        actions_hash:  crypto.randomBytes(32).toString('hex'),
        contract_hash: crypto.randomBytes(32).toString('hex'),
        checkpoint_seq: seq, snapshot_block: snapshotBlock, validator_signatures: '[]',
        state_root:        crypto.randomBytes(32).toString('hex'),
        state_root_version: 1,
        block_merkle_root:  crypto.randomBytes(32).toString('hex'),
        block_merkle_version: 1
    };
}

// Seqs must clear the indexer's per-chain replay guard (dirty regtest
// chains carry anchors from prior runs). v0 section rows carry their own
// per-chain checkpoint_seq, so this reads exactly as it does per row.
async function nextSeq(chain){
    const r = await indexerQuery(
        'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS s FROM anchor_actions WHERE chain = ? AND network = ?',
        [chain, 'regtest']);
    return Number(r[0].s);
}

// Every v0 bundle this run put on the wire, parsed. The archive leg (v1)
// and any earlier run's wires are filtered out by the parser.
function bundles(){
    return anchorVersions.bundleBroadcasts(S.published);
}

module.exports = {
    N, sleep, S, bundleKey, rankOrder, indexerQuery, allHubs,
    insertCheckpointEverywhere, syntheticCheckpoint, nextSeq, bundles
};
