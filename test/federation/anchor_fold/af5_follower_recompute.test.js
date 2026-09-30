'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');

const FOLD_ENV = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION';
const priorFoldEnv = process.env[FOLD_ENV];
process.env[FOLD_ENV] = '0';

const {
    MultiValidatorHub,
    ValidatorIdentity,
    loadHubModule
} = require('../../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../../helpers/disposableHubDb');
const { seedWeightSnapshot } = require('../../helpers/seededWeightSnapshot');

const CheckpointEngine = loadHubModule('src/anchor/checkpoint_engine.js');
const XChainHub = loadHubModule('src/XChainHub.js');
const { extendWrapperCanonicalBase, foldArchiveSuffix } =
    loadHubModule('src/anchor/publisher/fold/wrapper_canonical.js');

const SNAPSHOT_BLOCK = 240;

function localTipHub(...args){
    const hub = new XChainHub(...args);
    hub.resolveBtcLatestBlock = async () => SNAPSHOT_BLOCK;
    hub.resolveDogeLatestBlock = async () => 0;
    hub.capabilitySnapshot.getActiveValidatorSnapshot = async () => ({ validators: [] });
    return hub;
}

function checkpointFixture(identities){
    const row = {
        chain: 'BTC', network: 'regtest', block_index: 840,
        block_hash: '11'.repeat(32), ledger_hash: '22'.repeat(32),
        actions_hash: '33'.repeat(32), contract_hash: '44'.repeat(32),
        checkpoint_seq: SNAPSHOT_BLOCK, snapshot_block: SNAPSHOT_BLOCK,
        state_root: '55'.repeat(32), state_root_version: 1,
        block_merkle_root: '66'.repeat(32), block_merkle_version: 1
    };
    const canonical = CheckpointEngine.canonicalCheckpoint(row);
    row.validator_signatures = JSON.stringify(identities.map((identity) => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical)
    })));
    return row;
}

async function insertCheckpoint(hub, row){
    await hub.db.createStateCheckpoint(
        row.chain, row.network, row.block_index, row.block_hash,
        row.ledger_hash, row.actions_hash, row.contract_hash,
        row.checkpoint_seq, row.snapshot_block, row.state_root,
        row.state_root_version, row.block_merkle_root,
        row.block_merkle_version, row.validator_signatures
    );
}

function wrapperCanonical(round, archive, overrides){
    archive = Object.assign({ match_batch_seq: archive.batch_seq }, archive, overrides);
    const suffix = foldArchiveSuffix(archive);
    const base = round.canonical.slice(0, round.canonical.length - suffix.length);
    return extendWrapperCanonicalBase(base, archive.wrapper_section_index, archive);
}

function foldedRequest(publisher, sections, archive){
    const pubkey = publisher.identity.getPubkeyHex().toLowerCase();
    return { data: {
        network: 'regtest', snapshot_block: SNAPSHOT_BLOCK,
        sections, publisher: pubkey, sig_pubkey: pubkey,
        archive
    } };
}

let hubDb = null;
let mvh = null;
let weightSeed = null;
let proposer = null;
let follower = null;

async function setupHubs(){
    hubDb = await startDisposableHubDb({
        forceDocker: true,
        name: 'xchain-anchor-fold-follower-' + process.pid
    });
    if(!hubDb){
        console.log('Skipping ANCHOR fold follower recomputation: no Docker available for the disposable hub DB');
        this.skip();
    }
    mvh = new MultiValidatorHub({
        count: 2, basePort: 34600,
        startCrossChain: true, startAttestation: false,
        dbNamePrefix: 'XChain_Regtest_Anchor_Fold_' + process.pid + '_',
        hubFactory: localTipHub
    });
    await mvh.start();
    [proposer, follower] = mvh.hubs.map((hub) => hub.stateAnchorPublisher);
    weightSeed = seedWeightSnapshot(mvh, { blockIndex: SNAPSHOT_BLOCK, network: 'regtest' });
    for(const hub of mvh.hubs) hub.stateAnchorPublisher.network = 'regtest';
    const identities = mvh.identities.map((item) => new ValidatorIdentity(item.privkeyHex));
    const checkpoint = checkpointFixture(identities);
    for(const hub of mvh.hubs) await insertCheckpoint(hub, checkpoint);
}

async function stopHubs(){
    if(weightSeed) weightSeed.restore();
    if(mvh){ await mvh.stop(); await mvh.dropDatabases(); }
    if(hubDb) await hubDb.stop();
    if(priorFoldEnv === undefined) delete process.env[FOLD_ENV];
    else process.env[FOLD_ENV] = priorFoldEnv;
}

async function recomputeAndCosign(){
    const proposerRows = await proposer.db.getStateCheckpointByNetwork('regtest');
    const followerRows = await follower.db.getStateCheckpointByNetwork('regtest');
    const proposerRound = await proposer.buildFoldArchiveSection(proposerRows, 'regtest');
    const followerRound = await follower.buildFoldArchiveSection(followerRows, 'regtest');
    assert.ok(proposerRound && followerRound, 'both hubs built the folded archive from held state');
    const proposerArchive = proposer.foldArchiveRequest(proposerRound);
    const followerArchive = follower.foldArchiveRequest(followerRound);
    assert.strictEqual(followerArchive.total_chunks, proposerArchive.total_chunks,
        'follower recomputed the proposer TOTAL_CHUNKS');

    const proposerCanonical = wrapperCanonical(proposerRound, proposerArchive);
    const followerCanonical = wrapperCanonical(followerRound, followerArchive);
    assert.strictEqual(followerCanonical, proposerCanonical, 'follower recomputed the proposer wrapper-section archive canonical');

    const signed = await follower.coSignFoldArchiveRequest(
        foldedRequest(proposer, proposerRows, proposerArchive));
    assert.ok(signed && signed.reply.archive_sig, 'follower returned an archive co-signature');
    const followerPubkey = follower.identity.getPubkeyHex().toLowerCase();
    assert.ok(ValidatorIdentity.verify(proposerCanonical, signed.reply.archive_sig, followerPubkey),
        'follower co-signature verifies against the proposer canonical');

    const held = await follower.db.getStateCheckpointByNetwork('regtest');
    assert.strictEqual(held[0].batch_seq, null, 'follower still holds pre-round archive state only');
    assert.strictEqual(held[0].anchor_txid, null, 'follower has no published-round state');
}

describe('ANCHOR fold follower recomputation', function () {
    this.timeout(120000);
    before(setupHubs);
    after(stopHubs);
    it('recomputes the proposer archive and co-signs its canonical from pre-round state', recomputeAndCosign);
});
