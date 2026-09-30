'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');

const FOLD_ENV = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION';
const priorFoldEnv = process.env[FOLD_ENV];
process.env[FOLD_ENV] = '0';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { encode: wifEncode } = require('wif');

const cryptoHelper = require('../../cryptoHelper');
const CryptoNetworks = require('../../../src/CryptoNetworks');
const Database = require('../../../src/db');
const {
    MultiValidatorHub,
    ValidatorIdentity,
    loadHubModule,
    resolveHubFile
} = require('../../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../../helpers/disposableHubDb');
const { corruptFinalChunk } = require('../../helpers/anchor_fold/corrupt_final_chunk');
const { statusesForAction } = require('../../helpers/anchor_fold/action_row_statuses');
const { ensureOpenIndexerDatabase } = require('../../helpers/anchor_fold/indexer_pool');

const CheckpointEngine = loadHubModule('src/anchor/checkpoint_engine.js');
const { foldArchiveCanonical } = loadHubModule('src/anchor/publisher/canonical_forms.js');

if(priorFoldEnv === undefined) delete process.env[FOLD_ENV];
else process.env[FOLD_ENV] = priorFoldEnv;

const HUB_DB_PORT = 14600 + (process.pid % 300);
const HUB_DB_NAME = 'xchain-anchor-fold-late-crc-' + process.pid;
const SNAPSHOT_BLOCK = 1900000 + (Date.now() % 100000);
const CHUNK_BYTES = 512;
const CHAINS = ['BTC', 'DOGE'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let hubDb = null;
let indexerDb = null;
let mvh = null;
let publisher = null;
let identity = null;
let signerDir = null;
let signerHooks = null;
let checkpointSeqBase = 0;
let batchSeq = 0;

function assertArchiveOnlyInvalid(statuses, chainCount){
    const chainValid = Array(chainCount).fill('valid');
    assert.deepStrictEqual(statuses, { chainStatuses: chainValid, archiveStatuses: ['invalid_archive'] }, 'late chunk CRC failure invalidated only the archive row');
}

function restoreFoldEnv(){
    if(priorFoldEnv === undefined) delete process.env[FOLD_ENV];
    else process.env[FOLD_ENV] = priorFoldEnv;
}

async function indexerQuery(sql, params){
    const conn = await indexerDb.getConnection();
    try { return await conn.query(sql, params); }
    finally { await conn.release(); }
}

async function openIndexerDb(){
    const shared = global.indexerDatabase;
    assert.ok(shared, 'the venue exposes its indexer database configuration');
    indexerDb = new Database(shared.host, shared.port, shared.dbName, shared.user, shared.pass);
    assert.ok(await indexerDb.ping(), 'the AF3 indexer database pool is ready');
}

async function closeIndexerDb(){
    if(!indexerDb) return;
    const owned = indexerDb;
    indexerDb = null;
    await owned.pool.end();
}

function signerDependencyPath(dep){
    try { return path.dirname(require.resolve(dep + '/package.json')); }
    catch(error){
        const target = path.resolve(__dirname, '../../../../', dep);
        if(!fs.existsSync(target)) throw error;
        return target;
    }
}

function stageProductionSigner(addressInfo){
    signerDir = path.join(require('os').tmpdir(), 'xchain-anchor-fold-crc-signer-' + process.pid);
    fs.rmSync(signerDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(signerDir, 'node_modules'), { recursive: true });
    fs.copyFileSync(resolveHubFile('examples/doge-signer.example.js'), path.join(signerDir, 'signer.js'));
    for(const dep of ['xchain-sdk', 'dotenv'])
        fs.symlinkSync(signerDependencyPath(dep), path.join(signerDir, 'node_modules', dep), 'dir');

    const network = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK);
    process.env.DOGE_NETWORK = COIN + '-' + NETWORK;
    process.env.DOGE_ADDRESS = addressInfo.address;
    process.env.DOGE_WIF = wifEncode(network.wif, Buffer.from(addressInfo.privateKey), true);
    process.env.DOGE_ENCODER_URL = 'http://' + (process.env.ENCODER_URL || 'localhost') + ':' +
        (process.env.ENCODER_API_PORT || '3023');
    process.env.HUB_SIGNER_MODULE = path.join(signerDir, 'signer.js');
    return loadHubModule('src/lib/signer_loader.js').loadSignerHooks(process.env);
}

async function settleTracker(){
    await regtestMinerConnector.generateBlocks(1);
    const status = await utxoTrackerConnector.quiesce({
        timeoutMs: 60000,
        pollMs: 250,
        regtestMiner: regtestMinerConnector
    });
    // Require each spend to become visible before the next continuation uses the wallet.
    assert.ok(status && status.ready, 'the UTXO tracker settled after the ANCHOR broadcast');
}

async function seedCapabilityRows(){
    const pubkey = identity.getPubkeyHex().toLowerCase();
    await indexerQuery(
        'INSERT INTO capability_snapshots ' +
        '(snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE amount = VALUES(amount), source = VALUES(source)',
        [SNAPSHOT_BLOCK, 'oracle_publish', pubkey, '1000', pubkey]
    );
}

async function readSequenceBases(){
    const rows = await indexerQuery(
        `SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS checkpoint_seq,
                COALESCE(MAX(match_batch_seq), -1) + 1 AS batch_seq
         FROM anchor_actions`);
    checkpointSeqBase = Number(rows[0].checkpoint_seq);
    batchSeq = Number(rows[0].batch_seq);
}

function checkpointFixture(chain, chainIndex){
    const row = {
        chain,
        network: 'regtest',
        block_index: SNAPSHOT_BLOCK + chainIndex,
        block_hash: crypto.randomBytes(32).toString('hex'),
        ledger_hash: crypto.randomBytes(32).toString('hex'),
        actions_hash: crypto.randomBytes(32).toString('hex'),
        contract_hash: crypto.randomBytes(32).toString('hex'),
        checkpoint_seq: checkpointSeqBase + chainIndex,
        snapshot_block: SNAPSHOT_BLOCK,
        state_root: crypto.randomBytes(32).toString('hex'),
        state_root_version: 1,
        block_merkle_root: crypto.randomBytes(32).toString('hex'),
        block_merkle_version: 1
    };
    const pubkey = identity.getPubkeyHex().toLowerCase();
    row.validator_signatures = JSON.stringify([{
        pubkey,
        sig: identity.sign(CheckpointEngine.canonicalCheckpoint(row))
    }]);
    return row;
}

function archiveFixture(){
    const json = JSON.stringify({
        v: 1,
        network: 'regtest',
        batch_seq: batchSeq,
        matches: [{ match_id: crypto.randomBytes(32).toString('hex') }],
        calls: [],
        rewards: [],
        pad: crypto.randomBytes(1200).toString('hex'),
        capability_snapshots: []
    });
    publisher.chunkMaxBytes = CHUNK_BYTES;
    const wire = publisher.archiveWire(json);
    // Require a continuation so the failure arrives after the folded head.
    assert.ok(wire.chunks.length > 1, 'the archive fixture split into continuation chunks');
    return { count: 1, crc: wire.crc, chunks: wire.chunks };
}

function foldedWire(){
    const sections = CHAINS.map(checkpointFixture);
    const archive = archiveFixture();
    const canonical = foldArchiveCanonical(
        sections[0], batchSeq, archive.count, archive.crc, archive.chunks.length);
    const pubkey = identity.getPubkeyHex().toLowerCase();
    const archiveSection = {
        wrapperSectionIndex: 0,
        batchSeq,
        count: archive.count,
        crc: archive.crc,
        chunks: archive.chunks,
        signatures: [{ pubkey, sig: identity.sign(canonical) }]
    };
    // Signs the publisher attestation the indexer requires on every v3 bundle tail
    // (ATTEST_SIG_COUNT at least 1); without it every chain section reads invalid.
    const header = { network: 'regtest', snapshot_block: SNAPSHOT_BLOCK };
    const attestSigs = [{ pubkey, sig: identity.sign(publisher.attestationCanonical(header, pubkey)) }];
    const payload = publisher.buildV3Payload(header, sections, archiveSection, pubkey, attestSigs);
    return { payload, chunks: archive.chunks };
}

async function broadcast(payload){
    const result = await signerHooks.broadcastFn(payload);
    // Require the production two-phase signer for every head and continuation.
    assert.ok(result && result.txid, 'the ANCHOR payload published with a reveal txid');
    assert.ok(result.phase1_txid, 'the ANCHOR payload published with a funding txid');
    assert.notStrictEqual(result.phase1_txid, result.txid,
        'the funding and reveal transactions are distinct');
    await settleTracker();
}

async function publishCorruptedArchive(wire){
    await broadcast(wire.payload);
    const corrupted = corruptFinalChunk(wire.chunks);
    // Pin the mutation to the late final continuation.
    assert.deepStrictEqual(corrupted.slice(0, -1), wire.chunks.slice(0, -1));
    assert.notStrictEqual(corrupted[corrupted.length - 1], wire.chunks[wire.chunks.length - 1]);
    for(let index = 1; index < corrupted.length; index++){
        const payload = ['ANCHOR', '2', batchSeq, index, corrupted.length, corrupted[index]].join('|');
        await broadcast(payload);
    }
}

async function foldedActionRows(){
    const heads = await indexerQuery(
        `SELECT action_index FROM anchor_actions
         WHERE version = 3 AND match_batch_seq = ?
         ORDER BY action_index DESC LIMIT 1`, [batchSeq]);
    if(heads.length === 0) return null;
    const actionIndex = Number(heads[0].action_index);
    const rows = await indexerQuery(
        `SELECT a.action_index, a.section_index, a.version, a.chain,
                a.match_batch_seq, s.status
         FROM anchor_actions a
         LEFT JOIN index_statuses s ON s.id = a.status_id
         WHERE a.action_index = ?
         ORDER BY a.section_index ASC`, [actionIndex]);
    const chunks = await indexerQuery(
        `SELECT COUNT(*) AS count FROM anchor_actions
         WHERE version = 2 AND match_batch_seq = ?`, [batchSeq]);
    return { actionIndex, rows, chunkCount: Number(chunks[0].count) };
}

async function waitForArchiveVerdict(totalChunks){
    const deadline = Date.now() + 180000;
    let observed = null;
    while(Date.now() < deadline){
        observed = await foldedActionRows();
        if(observed){
            const statuses = statusesForAction(observed.rows, observed.actionIndex);
            if(observed.chunkCount === totalChunks - 1 &&
               statuses.archiveStatuses[0] === 'invalid_archive') return observed;
        }
        await regtestMinerConnector.generateBlocks(1);
        await sleep(2000);
    }
    assert.fail('folded archive batch ' + batchSeq + ' did not reach the late CRC verdict: ' +
        JSON.stringify(observed));
}

async function setup(){
    await ensureOpenIndexerDatabase();
    process.env[FOLD_ENV] = '0';
    process.env.XDEX_SNAPSHOT_BLOCK = String(SNAPSHOT_BLOCK);
    process.env.CHECKPOINT_CHAINS = 'DOGE';
    process.env.CHECKPOINT_POLL_MS = '600000000';
    process.env.ANCHOR_INTERVAL_MS = '600000000';
    process.env.XCHAIN_CONFIRMATIONS_DOGE = '1';
    if(!process.env.DOGE_INDEXER_URL)
        process.env.DOGE_INDEXER_URL = 'http://localhost:' +
            (process.env.INDEXER_API_PORT || '3124');

    await openIndexerDb();
    hubDb = await startDisposableHubDb({
        forceDocker: true,
        port: HUB_DB_PORT,
        name: HUB_DB_NAME
    });
    if(!hubDb) return;
    mvh = new MultiValidatorHub({
        count: 1,
        basePort: 31600,
        startCrossChain: true,
        startAttestation: false,
        dbNamePrefix: 'XChain_DOGE_Regtest_Anchor_Fold_CRC_' + process.pid + '_'
    });
    await mvh.start();
    publisher = mvh.hubs[0].stateAnchorPublisher;
    publisher.network = 'regtest';
    identity = new ValidatorIdentity(mvh.identities[0].privkeyHex);
    await seedCapabilityRows();
    await readSequenceBases();

    const addressInfo = await cryptoHelper.getNewFundedAddress(
        'anchor-fold-crc-publisher', COIN, NETWORK, null, 'legacy', 0, 10.0, false);
    await settleTracker();
    signerHooks = stageProductionSigner(addressInfo);
    // Require the same signer-loader path used by an operator deployment.
    assert.ok(signerHooks && signerHooks.broadcastFn,
        'the production DOGE signer exposes its broadcast hook');
}

async function teardown(){
    try {
        if(mvh){ await mvh.stop(); await mvh.dropDatabases(); }
        if(hubDb) await hubDb.stop();
        if(signerDir) fs.rmSync(signerDir, { recursive: true, force: true });
        delete process.env.DOGE_WIF;
        delete process.env.HUB_SIGNER_MODULE;
        restoreFoldEnv();
    } finally {
        await closeIndexerDb();
    }
}

describe('ANCHOR fold late CRC verdict scope', function () {
    this.timeout(15 * 60 * 1000);

    before(setup);
    after(teardown);

    it('keeps every chain section valid and invalidates only the archive row', async function () {
        if(!hubDb){
            console.log('Skipping ANCHOR fold late CRC scope: no Docker available for the disposable hub DB');
            this.skip();
        }
        const wire = foldedWire();
        await publishCorruptedArchive(wire);
        const observed = await waitForArchiveVerdict(wire.chunks.length);
        const statuses = statusesForAction(observed.rows, observed.actionIndex);
        assertArchiveOnlyInvalid(statuses, CHAINS.length);
    });
});
