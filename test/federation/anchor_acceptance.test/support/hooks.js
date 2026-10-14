/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const fs = require('fs');

const cryptoHelper = require('../../../helpers/core/cryptoHelper');
const { MultiValidatorHub, ValidatorIdentity, loadHubModule } = require('../../../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../../../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../../../helpers/seededWeightSnapshot');
const { HUB_DB_PORT, HUB_DB_NAME, SNAPSHOT_BLOCK, S, indexerQuery } = require('./state');
const { stageProductionSigner } = require('./signer');

// Deterministic regtest seams: set BEFORE any hub engine is constructed.
function configureEnv(){
    process.env.XDEX_SEED_LOCAL_VALIDATOR = '1';
    process.env.XDEX_SNAPSHOT_BLOCK       = String(SNAPSHOT_BLOCK);
    process.env.CHECKPOINT_CHAINS         = 'DOGE';
    process.env.CHECKPOINT_CONFIRMATIONS  = '2';
    process.env.CHECKPOINT_POLL_MS        = '600000';      // manual ticks only
    process.env.ANCHOR_INTERVAL_MS        = '600000000';   // manual flush only
    if(!process.env.DOGE_INDEXER_URL)
        process.env.DOGE_INDEXER_URL = 'http://localhost:' + (process.env.INDEXER_API_PORT || '3124');
    // Gap (c): coins/DOGE.js's confirmations:60 (StateAnchorPublisher.dogeConfirmations,
    // frozen at hub construction below) is unreachable inside this suite's block
    // budget. Must be set BEFORE `new MultiValidatorHub` / mvh.start(), which is
    // when coins.resolveConfirmations reads it.
    process.env.XCHAIN_CONFIRMATIONS_DOGE = '1';
}

// Gap (b): the local indexer is DOGE, not BTC, so hub.capabilitySnapshot's
// live getSnapshot/getWeightSnapshot calls fail (wrong-chain indexer), and
// getActiveOraclePublishPubkeys has NO local-table fallback (unlike
// resolveCapabilitySet) -- it just returns [] and every anchor gets deferred
// "empty oracle_publish set (fail closed)". seedWeightSnapshot patches
// getWeightSnapshot/getActiveWeightSnapshot directly (the one seam both
// election and signing-set resolution share) and sets hub.network='regtest'
// so the WEIGHTED path is taken. Single-hub venue -> this hub's own identity
// is the sole (100%-stake) source, matching the `identity` that signs.
function seedWeights(){
    S.weightSeed = seedWeightSnapshot(S.mvh, { blockIndex: SNAPSHOT_BLOCK, network: 'regtest' });
    // Defensive mirror of the proven StateCheckpointEngine gotcha (see
    // multiHubStateAnchorWeighted.integration.test.js): every consensus engine,
    // StateAnchorPublisher included, caches `this.network = hub.network` ONCE AT
    // CONSTRUCTION (anchor/publisher.js:170), before seedWeightSnapshot ever
    // runs. HUB_NETWORK is threaded through MultiValidatorHub's p2pConfig
    // (defaults to regtest) so this is likely already correct by construction,
    // but setting it again here costs nothing and removes the dependency on that
    // threading being intact.
    S.hub.stateAnchorPublisher.network = 'regtest';
}

async function bootHub(){
    S.mvh = new MultiValidatorHub({
        count: 1, basePort: 34100,
        startCrossChain: true, startAttestation: false,
        dbNamePrefix: 'XChain_DOGE_Regtest_ANCHOR_' + process.pid + '_'
    });
    await S.mvh.start();
    S.hub      = S.mvh.hubs[0];
    S.identity = new ValidatorIdentity(S.mvh.identities[0].privkeyHex);
    // The hub's OWN canonical builder, so the synthetic BTC/LTC sections are
    // signed over byte-identical bytes to what the indexer rebuilds. Never
    // re-implemented in the test: a drifting copy would fail closed as
    // 'invalid: SECTION n' and read as a publisher bug.
    S.SCE = loadHubModule('src/anchor/checkpoint_engine.js');
    seedWeights();
}

// Fund the publisher address; every ANCHOR broadcast goes through the
// REAL client pipeline (encoder createTx -> sign -> broadcast -> P2SH
// reveal tx), identical to how a production operator publishes.
async function fundPublisher(){
    S.publisherAddr = await cryptoHelper.getNewFundedAddress(
        'anchor-publisher', COIN, NETWORK, null, 'legacy', 0, 2.0
    );
    await regtestMinerConnector.generateBlocks(2);
    await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
}

// PRODUCTION signer path: signer-loader -> staged doge-signer.example.js
// -> sdk two-phase P2SH pipeline. The wrapper only adds regtest
// block-production so the tracker sees fresh UTXOs before the next
// publish in the same flush.
function wireBroadcastHook(){
    const hooks = stageProductionSigner(S.publisherAddr);
    S.hub.stateAnchorPublisher.setBroadcastHook(async (payload) => {
        const result = await hooks.broadcastFn(payload);
        S.broadcasts.push({ payload, txid: result.txid, phase1_txid: result.phase1_txid });
        await regtestMinerConnector.generateBlocks(1);
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
        return result;
    });
}

// Highest checkpoint and archive batch sequence a prior run already anchored.
// Version lists cover the WHOLE family on each leg, retired digits included:
// checkpoint 0/3/4/5 (the retired per-chain wires) plus 7 (the interim bundle
// whose digit was renumbered to 0); archive 1/6 (1 tail-less legacy, 6 the
// interim tailed archive renumbered to v1). A dirty regtest chain can carry a
// prior run's rows under ANY of these, and a scan narrowed to the live (0,1)
// would miss them and restart the seqs low enough for the indexer's replay
// guard to reject this run's anchors.
async function priorMaxSeqs(){
    const prior = await indexerQuery(
        `SELECT MAX(checkpoint_seq) AS max_cp,
                (SELECT MAX(match_batch_seq) FROM anchor_actions WHERE version IN (1, 6)) AS max_batch
         FROM anchor_actions WHERE version IN (0, 1, 3, 4, 5, 6, 7)`);
    return {
        maxCp:    (prior.length && prior[0].max_cp    != null) ? Number(prior[0].max_cp)    : null,
        maxBatch: (prior.length && prior[0].max_batch != null) ? Number(prior[0].max_batch) : null
    };
}

// Rerunnability on a dirty regtest chain: the indexer's replay guards
// reject seqs at-or-below the on-chain max, and this driver's hub DB is
// fresh (seqs restart at 0). Seed the hub's counters past whatever a
// prior run already anchored.
async function seedSeqBaselines(){
    const { maxCp, maxBatch } = await priorMaxSeqs();
    if (maxCp !== null) {
        await S.hub.db.doQuery(
            `INSERT IGNORE INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash,
                actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures, anchor_txid)
             VALUES ('DOGE', 'regtest', 0, ?, ?, ?, ?, ?, ?, '[]', 'seq-baseline')`,
            ['0'.repeat(64), '0'.repeat(64), '0'.repeat(64), '0'.repeat(64), maxCp, SNAPSHOT_BLOCK]);
    }
    if (maxBatch !== null) {
        await S.hub.db.doQuery(
            `INSERT IGNORE INTO cross_chain_matches
                (match_id, snapshot_block, network, a_chain, a_action_index, a_tick, a_amount, a_payout_addr,
                 b_chain, b_action_index, b_tick, b_amount, b_payout_addr, effective_time,
                 validator_signatures, status, batch_seq, archived_status)
             VALUES ('seq-baseline', ?, 'regtest', 'DOGE', 0, 'X', '0', 'x', 'LTC', 0, 'X', '0', 'x', 0,
                     '[]', 'finalized', ?, 'finalized')`,
            [SNAPSHOT_BLOCK, maxBatch]);
    }
}

// Gap (a): the ambient venue credential (xchain_hub / the indexer DB user)
// authenticates but lacks CREATE DATABASE, which MultiValidatorHub needs (one
// DB per hub). forceDocker:true is required -- without it, resolution path (1)
// in disposableHubDb hands back that same venue credential (it's already in
// env on a live host) instead of provisioning a throwaway root container.
async function startHubDb(ctx){
    S.hubDb = await startDisposableHubDb({ forceDocker: true, port: HUB_DB_PORT, name: HUB_DB_NAME });
    if (!S.hubDb) { console.log('Skipping ANCHOR live acceptance: no Docker available for the disposable hub DB'); ctx.skip(); }
}

// Suite hooks, registered inside the parent describe.
function installHooks(){
    before(async function () {
        configureEnv();
        await startHubDb(this);
        await bootHub();
        await fundPublisher();
        wireBroadcastHook();
        await seedSeqBaselines();
    });

    after(async function () {
        if (S.weightSeed) S.weightSeed.restore();
        if (S.mvh) { await S.mvh.stop(); await S.mvh.dropDatabases(); }
        if (S.hubDb) await S.hubDb.stop();
        if (S.signerDir) fs.rmSync(S.signerDir, { recursive: true, force: true });
        delete process.env.DOGE_WIF;
        delete process.env.HUB_SIGNER_MODULE;
    });
}

module.exports = { installHooks };
