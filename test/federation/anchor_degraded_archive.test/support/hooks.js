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
const { loadHubModule } = require('../../../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../../../helpers/disposableHubDb');
const { S, HUB_DB_PORT, HUB_DB_NAME } = require('./state');
const { stageProductionSigner } = require('./signer');
const { stopFederation } = require('./federation');

// Deterministic regtest seams, all set BEFORE any hub engine is constructed.
function configureEnv(){
    process.env.CHECKPOINT_CHAINS         = 'DOGE';
    process.env.CHECKPOINT_POLL_MS        = '600000000';   // no engine ticks: checkpoints are inserted here
    process.env.ANCHOR_INTERVAL_MS        = '600000000';   // manual flush only
    process.env.ANCHOR_ELECTION_TOLERANCE_BLOCKS = '100000';  // only rank 0 ever unlocks
    // The capability sets are seeded per federation; a local-seed seam left over
    // from another suite in this process would shadow them.
    delete process.env.XDEX_SEED_LOCAL_VALIDATOR;
    if(!process.env.DOGE_INDEXER_URL)
        process.env.DOGE_INDEXER_URL = 'http://localhost:' + (process.env.INDEXER_API_PORT || '3124');
    // coins/DOGE.js confirmations:60 is frozen into StateAnchorPublisher.dogeConfirmations
    // at construction and is unreachable inside this suite's block budget; the
    // reward drain's on-chain proof reads it.
    process.env.XCHAIN_CONFIRMATIONS_DOGE = '1';
}

// One funded publisher wallet and one staged signer for the whole suite;
// publishes are serialized by runCycle's flush order throughout.
async function stageSigner(){
    // One funded publisher wallet and one staged signer for the whole suite;
    // publishes are serialized by runCycle's flush order throughout. Funded for
    // three federations' worth of TWO-PHASE publishes (up to about eight P2SH
    // funding + reveal pairs), where anchorAcceptance needs only two.
    S.publisherAddr = await cryptoHelper.getNewFundedAddress(
        'degraded-archive-publisher', COIN, NETWORK, null, 'legacy', 0, 12.0
    );
    await regtestMinerConnector.generateBlocks(2);
    await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
    S.signerHooks = stageProductionSigner(S.publisherAddr);
}

// Suite hooks, registered inside the parent describe.
function installHooks(){
    before(async function () {
        configureEnv();
        // forceDocker is required: without it, resolution path (1) hands back the
        // venue credential that authenticates but cannot CREATE DATABASE, and
        // MultiValidatorHub makes one DB per hub. One container serves every
        // federation; each makes its own databases and drops them on teardown.
        S.hubDb = await startDisposableHubDb({ forceDocker: true, port: HUB_DB_PORT, name: HUB_DB_NAME });
        if (!S.hubDb) { console.log('Skipping degraded-archive acceptance: no Docker available for the disposable hub DB'); this.skip(); }
    
        S.SAP = loadHubModule('src/anchor/publisher.js');
        S.SCE = loadHubModule('src/anchor/checkpoint_engine.js');
        await stageSigner();
    });

// Every test owns its federation, so nothing it published can reach the next.
afterEach(async function () {
    await stopFederation();
});

after(async function () {
    await stopFederation();
    if (S.hubDb) await S.hubDb.stop();
    if (S.signerDir) fs.rmSync(S.signerDir, { recursive: true, force: true });
    delete process.env.DOGE_WIF;
    delete process.env.HUB_SIGNER_MODULE;
});
}

module.exports = { installHooks };
