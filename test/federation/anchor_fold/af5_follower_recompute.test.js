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
const { isAnchorFoldActive, foldArchiveCanonical } =
    loadHubModule('src/anchor/publisher/canonical_forms.js');
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

async function seedArchiveSigningSet(hubs, snapshot){
    for(const hub of hubs){
        for(const validator of snapshot.validators){
            await hub.db.doQuery(
                'INSERT INTO capability_snapshots ' +
                '(snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?) ' +
                'ON DUPLICATE KEY UPDATE amount = VALUES(amount), source = VALUES(source)',
                [SNAPSHOT_BLOCK, 'oracle_publish', validator.pubkey,
                    String(validator.weight), String(validator.source)]
            );
        }
    }
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
    // Re-arms here: a suite run before this one in the same process restores the fold
    // variable in its own teardown, and the hubs read it at runtime.
    process.env[FOLD_ENV] = '0';
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
    // MultiValidatorHub re-applies the arm heights captured when its helper loaded (the
    // venue's 112 on a rail run), so the fold goes back to genesis here, after it: these
    // hubs read a DOGE tip of 0 and the co-sign gate checks the fold at that height.
    process.env[FOLD_ENV] = '0';
    [proposer, follower] = mvh.hubs.map((hub) => hub.stateAnchorPublisher);
    weightSeed = seedWeightSnapshot(mvh, { blockIndex: SNAPSHOT_BLOCK, network: 'regtest' });
    for(const hub of mvh.hubs) hub.stateAnchorPublisher.network = 'regtest';
    await seedArchiveSigningSet(mvh.hubs, weightSeed.snapshot);
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

    const local = await follower.db.getStateCheckpointByChain(
        String(proposerArchive.checkpoint.chain), 'regtest',
        Number(proposerArchive.checkpoint.block_index), Number(proposerArchive.checkpoint.checkpoint_seq));
    const mine = follower.ownArchiveWrapper(local, proposerArchive.checkpoint);
    const signingSet = await follower.archiveSigningSet(mine);
    const followerPubkey = follower.identity.getPubkeyHex().toLowerCase();
    assert.ok(signingSet.some((validator) => String(validator.pubkey).toLowerCase() === followerPubkey),
        'follower belongs to the oracle_publish archive signing set at snapshot block 240');
    const decoded = follower.decodeArchiveProposal(proposerArchive);
    assert.ok(decoded && await follower.verifyArchiveAgainstLocal(decoded, Number(mine.snapshot_block)),
        'follower verifies the proposer archive against its local checkpoint and capability rows');

    // The co-sign path refuses silently, so each of its remaining gates is checked here
    // first and a refusal names the gate and its inputs instead of a bare null.
    const request = foldedRequest(proposer, proposerRows, proposerArchive);
    const foldBlock = await follower.hub.resolveDogeLatestBlock();
    assert.ok(isAnchorFoldActive(Number(foldBlock), 'regtest'),
        'fold gate active for the follower at DOGE ' + foldBlock + ' (' + FOLD_ENV + '=' + process.env[FOLD_ENV] + ')');
    const section = request.data.sections[Number(proposerArchive.wrapper_section_index)];
    assert.ok(section && String(section.chain) === String(proposerArchive.checkpoint.chain) &&
        Number(section.block_index) === Number(proposerArchive.checkpoint.block_index) &&
        Number(section.checkpoint_seq) === Number(proposerArchive.checkpoint.checkpoint_seq),
        'wrapper section ' + proposerArchive.wrapper_section_index + ' of ' + request.data.sections.length +
        ' matches the archive checkpoint ' + JSON.stringify(proposerArchive.checkpoint));
    const nextSeq = await follower.getNextBatchSeq();
    assert.strictEqual(Number(nextSeq), Number(proposerArchive.batch_seq),
        'follower next batch seq matches the proposer archive batch seq');
    const localCanonical = foldArchiveCanonical(local[0], Number(proposerArchive.batch_seq),
        Number(proposerArchive.match_count), String(proposerArchive.batch_crc32), Number(proposerArchive.total_chunks));
    assert.strictEqual(localCanonical, proposerRound.canonical,
        'follower local archive canonical matches the proposer round canonical');
    assert.ok(ValidatorIdentity.verify(localCanonical, String(proposerArchive.sig || ''), request.data.sig_pubkey),
        'proposer archive signature verifies against the follower local canonical');

    const signed = await follower.coSignFoldArchiveRequest(request);
    assert.ok(signed && signed.reply.archive_sig, 'follower returned an archive co-signature');
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
