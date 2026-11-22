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

// Gap (a): forced off the ambient venue credential (CREATE DATABASE denied)
// onto a disposable Docker MariaDB. Port/name derived from the pid so this
// suite doesn't collide with another session's own disposable container on
// the shared venue.
const HUB_DB_PORT = 13300 + (process.pid % 300);
const HUB_DB_NAME = 'xchain-anchor-acceptance-hubdb-' + process.pid;

// Gap: self-poisoning re-runs (see the parent file header). Override for a
// deliberate replay against the same block; otherwise unique per run.
const SNAPSHOT_BLOCK = Number(process.env.ANCHOR_ACCEPTANCE_SNAPSHOT_BLOCK) || (200000 + (Date.now() % 700000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The one mutable record the hooks and both tests share.
const S = {
    mvh: null, hub: null, identity: null,
    hubDb: null,                 // gap (a): disposable Docker MariaDB handle
    weightSeed: null,            // gap (b): seededWeightSnapshot restore()
    publisherAddr: null,
    signerDir: null,             // staged production signer (~/hub-signer analogue)
    broadcasts: [],              // { payload, txid, phase1_txid }
    matchId: crypto.createHash('sha256').update('anchor-acceptance-' + Date.now()).digest('hex'),
    SCE: null,                   // hub's StateCheckpointEngine, for the canonical
    bundleSections: [],          // the three checkpoint rows the bundle carried
    bundleTxid: null             // AT4 reads the same bundle back through the RPC
};

async function indexerQuery(sql, params){
    const conn = await indexerDatabase.getConnection();
    try { return await conn.query(sql, params); }
    finally { await conn.release(); }
}

// The archive's own LEDGER_HASH field, read off the real v1 wire rather than
// assumed. StateAnchorPublisher elects the archive's WRAPPER checkpoint over
// every chain's state_checkpoints row for this network, preferring a BTC row
// when one exists (src/StateAnchorPublisher.js: "ORDER BY (chain = 'BTC')
// DESC, checkpoint_seq DESC, ..."), so on this suite's multi-chain flush the
// archive wraps the SYNTHETIC BTC checkpoint, not the DOGE one AT1 ticked.
// Narrowing the read-back lookup by the DOGE tick's own ledger_hash therefore
// never matches the row the indexer actually stored for the archive; reading
// the wrapper's ledger_hash straight off the broadcast payload (field 6 on
// the pipe-split wire: ANCHOR|1|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|
// LEDGER_HASH|..., the field order publishArchive emits and anchor/index.js
// parses) is what makes the narrowing key match the wrapper, whichever chain
// it turns out to be.
function archiveWrapperLedgerHash(payload){
    const f = String(payload || '').split('|');
    const hash = f[6];
    assert.match(String(hash), /^[0-9a-f]{64}$/i, 'v1 payload LEDGER_HASH field (index 6) is a 64-hex hash');
    return hash;
}

// A root-bearing checkpoint row for a chain this DOGE-only venue has no engine
// for, signed by the seeded validator over the hub's OWN canonical
// (StateCheckpointEngine.canonicalCheckpoint, the exact bytes the indexer's
// ANCHOR verifier and the SDK rebuild). Signing it here is what makes AT1's
// "all three sections valid" a real verdict: an unsigned filler row would
// invalidate the WHOLE bundle and the run would prove nothing.
//
// Roots are REQUIRED, not decorative: the publisher SKIPS a rootless row with a
// log line rather than emitting a rootless section, so a filler without
// them would be silently absent and the bundle would come out short.
function signedSyntheticCheckpoint(chain, seq, snapshotBlock){
    const row = {
        chain, network: 'regtest', block_index: 100000 + seq,
        block_hash:    crypto.randomBytes(32).toString('hex'),
        ledger_hash:   crypto.randomBytes(32).toString('hex'),
        actions_hash:  crypto.randomBytes(32).toString('hex'),
        contract_hash: crypto.randomBytes(32).toString('hex'),
        checkpoint_seq: seq, snapshot_block: snapshotBlock,
        state_root:           crypto.randomBytes(32).toString('hex'),
        state_root_version:   1,
        block_merkle_root:    crypto.randomBytes(32).toString('hex'),
        block_merkle_version: 1
    };
    row.validator_signatures = JSON.stringify([{
        pubkey: S.identity.getPubkeyHex().toLowerCase(),
        sig:    S.identity.sign(S.SCE.canonicalCheckpoint(row))
    }]);
    return row;
}

async function insertCheckpoint(row){
    await S.hub.db.doQuery(
        'INSERT IGNORE INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, ' +
        'actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures, ' +
        'state_root, state_root_version, block_merkle_root, block_merkle_version) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [row.chain, row.network, row.block_index, row.block_hash, row.ledger_hash,
         row.actions_hash, row.contract_hash, row.checkpoint_seq, row.snapshot_block,
         row.validator_signatures, row.state_root, row.state_root_version,
         row.block_merkle_root, row.block_merkle_version]);
}

module.exports = {
    HUB_DB_PORT, HUB_DB_NAME, SNAPSHOT_BLOCK, S, sleep, indexerQuery,
    archiveWrapperLedgerHash, signedSyntheticCheckpoint, insertCheckpoint
};
