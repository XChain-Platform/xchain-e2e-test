/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encode: wifEncode } = require('wif');

const MANAGED_ENV = [
    'XC_ANCHOR_FOLD_REGTEST_ACTIVATION', 'XDEX_SEED_LOCAL_VALIDATOR',
    'XDEX_SNAPSHOT_BLOCK', 'CHECKPOINT_CHAINS', 'CHECKPOINT_CONFIRMATIONS',
    'CHECKPOINT_POLL_MS', 'ANCHOR_INTERVAL_MS', 'XCHAIN_CONFIRMATIONS_DOGE',
    'DOGE_INDEXER_URL', 'DOGE_NETWORK', 'DOGE_ADDRESS', 'DOGE_WIF',
    'DOGE_ENCODER_URL', 'HUB_SIGNER_MODULE'
];
const priorEnv = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
const requireFederation = process.env.E2E_REQUIRE_FEDERATION === '1';
if(requireFederation) process.env.XC_ANCHOR_FOLD_REGTEST_ACTIVATION = '0';
else console.log('Skipping ANCHOR fold live acceptance: E2E_REQUIRE_FEDERATION=1 is not set');

const venueHooks = require('../../initialCheck.test.js').mochaHooks;
const cryptoHelper = require('../../cryptoHelper');
const CryptoNetworks = require('../../../src/CryptoNetworks');
const {
    MultiValidatorHub,
    ValidatorIdentity,
    loadHubModule,
    resolveHubFile
} = require('../../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../../helpers/disposableHubDb');
const { seedWeightSnapshot } = require('../../helpers/seededWeightSnapshot');
const { parseAnchorV3 } = require('../../helpers/anchor_fold/parse_anchor_v3');
const { selectSingleAnchorV3Broadcast } = require('../../helpers/anchor_fold/select_v3_broadcast');

const HUB_DB_NAME = 'xchain-anchor-fold-af1-' + process.pid;

let snapshotBlock = null;
let hubDb = null;
let mvh = null;
let hub = null;
let identity = null;
let checkpointEngine = null;
let weightSeed = null;
let signerDir = null;
let broadcasts = [];

function restoreManagedEnv(){
    for(const key of MANAGED_ENV){
        if(priorEnv[key] === undefined) delete process.env[key];
        else process.env[key] = priorEnv[key];
    }
}

function stageProductionSigner(addressInfo){
    signerDir = path.join(os.tmpdir(), 'xchain-anchor-fold-signer-' + process.pid);
    fs.rmSync(signerDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(signerDir, 'node_modules'), { recursive: true });
    fs.copyFileSync(resolveHubFile('examples/doge-signer.example.js'), path.join(signerDir, 'signer.js'));
    for(const dependency of ['xchain-sdk', 'dotenv']){
        let target;
        try { target = path.dirname(require.resolve(dependency + '/package.json')); }
        catch(_){ target = path.resolve(__dirname, '../../../', dependency); }
        fs.symlinkSync(target, path.join(signerDir, 'node_modules', dependency), 'dir');
    }
    const network = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK);
    process.env.DOGE_NETWORK = COIN + '-' + NETWORK;
    process.env.DOGE_ADDRESS = addressInfo.address;
    process.env.DOGE_WIF = wifEncode(network.wif, Buffer.from(addressInfo.privateKey), true);
    process.env.DOGE_ENCODER_URL = 'http://' + (process.env.ENCODER_URL || 'localhost') + ':' +
        (process.env.ENCODER_API_PORT || '3023');
    process.env.HUB_SIGNER_MODULE = path.join(signerDir, 'signer.js');
    return loadHubModule('src/lib/signer_loader.js').loadSignerHooks(process.env);
}

async function indexerQuery(sql, params){
    const connection = await indexerDatabase.getConnection();
    try { return await connection.query(sql, params); }
    finally { await connection.release(); }
}

async function indexedBtcBlock(){
    const url = process.env.BTC_INDEXER_API_URL;
    assert.ok(url, 'the BTC indexer URL is configured');
    const headers = { 'content-type': 'application/json' };
    if(process.env.BTC_INDEXER_API_KEY) headers['x-api-key'] = process.env.BTC_INDEXER_API_KEY;
    const response = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getlatestblock', params: {} })
    });
    assert.ok(response.ok, 'the BTC indexer latest-block request succeeded');
    const body = await response.json();
    const block = Number(body.result && body.result.block_index);
    assert.ok(Number.isSafeInteger(block) && block >= 0, 'the BTC indexer returned a committed block');
    return block;
}

function signedCheckpoint(chain, sequence, snapshotBlock){
    const row = {
        chain, network: 'regtest', block_index: 100000 + sequence,
        block_hash: crypto.randomBytes(32).toString('hex'),
        ledger_hash: crypto.randomBytes(32).toString('hex'),
        actions_hash: crypto.randomBytes(32).toString('hex'),
        contract_hash: crypto.randomBytes(32).toString('hex'),
        checkpoint_seq: sequence, snapshot_block: snapshotBlock,
        state_root: crypto.randomBytes(32).toString('hex'), state_root_version: 1,
        block_merkle_root: crypto.randomBytes(32).toString('hex'), block_merkle_version: 1
    };
    row.validator_signatures = JSON.stringify([{
        pubkey: identity.getPubkeyHex().toLowerCase(),
        sig: identity.sign(checkpointEngine.canonicalCheckpoint(row))
    }]);
    return row;
}

async function insertCheckpoint(row){
    await hub.db.doQuery(
        'INSERT INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, ' +
        'actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures, ' +
        'state_root, state_root_version, block_merkle_root, block_merkle_version) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [row.chain, row.network, row.block_index, row.block_hash, row.ledger_hash,
            row.actions_hash, row.contract_hash, row.checkpoint_seq, row.snapshot_block,
            row.validator_signatures, row.state_root, row.state_root_version,
            row.block_merkle_root, row.block_merkle_version]
    );
}

async function seedSequenceFloors(){
    const prior = await indexerQuery(
        'SELECT MAX(checkpoint_seq) AS max_cp, ' +
        '(SELECT MAX(match_batch_seq) FROM anchor_actions ' +
        'WHERE match_batch_seq IS NOT NULL AND version <> 2) AS max_batch FROM anchor_actions'
    );
    if(prior[0].max_cp != null){
        await hub.db.doQuery(
            `INSERT INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash,
                actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures, anchor_txid)
             VALUES ('DOGE', 'regtest', 0, ?, ?, ?, ?, ?, ?, '[]', 'seq-baseline')`,
            ['0'.repeat(64), '0'.repeat(64), '0'.repeat(64), '0'.repeat(64),
                Number(prior[0].max_cp), snapshotBlock]
        );
    }
    if(prior[0].max_batch != null) await insertArchiveFloor(Number(prior[0].max_batch));
}

async function insertArchiveFloor(batchSequence){
    await hub.db.doQuery(
        `INSERT INTO cross_chain_matches
            (match_id, snapshot_block, network, a_chain, a_action_index, a_tick, a_amount, a_payout_addr,
             b_chain, b_action_index, b_tick, b_amount, b_payout_addr, effective_time,
             validator_signatures, status, batch_seq, archived_status)
         VALUES ('seq-baseline', ?, 'regtest', 'DOGE', 0, 'X', '0', 'x', 'BTC', 0, 'X', '0', 'x', 0,
                 '[]', 'finalized', ?, 'finalized')`,
        [snapshotBlock, batchSequence]
    );
}

async function startVenue(){
    await venueHooks.beforeAll.call(this);
    // Keep this acceptance tied to the DOGE regtest venue.
    assert.strictEqual(COIN + '-' + NETWORK, 'dogecoin-regtest');
}

async function startHub(){
    snapshotBlock = await indexedBtcBlock();
    process.env.XDEX_SEED_LOCAL_VALIDATOR = '1';
    process.env.XDEX_SNAPSHOT_BLOCK = String(snapshotBlock);
    process.env.CHECKPOINT_CHAINS = 'DOGE';
    process.env.CHECKPOINT_CONFIRMATIONS = '2';
    process.env.CHECKPOINT_POLL_MS = '600000';
    process.env.ANCHOR_INTERVAL_MS = '600000000';
    process.env.XCHAIN_CONFIRMATIONS_DOGE = '1';
    if(!process.env.DOGE_INDEXER_URL)
        process.env.DOGE_INDEXER_URL = 'http://localhost:' + (process.env.INDEXER_API_PORT || '3124');
    hubDb = await startDisposableHubDb({ forceDocker: true, name: HUB_DB_NAME });
    assert.ok(hubDb, 'Docker is required for the disposable hub DB');
    mvh = new MultiValidatorHub({
        count: 1, basePort: 34700, startCrossChain: true, startAttestation: false,
        dbNamePrefix: 'XChain_DOGE_Regtest_Anchor_Fold_' + process.pid + '_'
    });
    await mvh.start();
    hub = mvh.hubs[0];
    identity = new ValidatorIdentity(mvh.identities[0].privkeyHex);
    checkpointEngine = loadHubModule('src/anchor/checkpoint_engine.js');
    weightSeed = seedWeightSnapshot(mvh, { blockIndex: snapshotBlock, network: 'regtest' });
    hub.stateAnchorPublisher.network = 'regtest';
    await wireBroadcastHook();
    await seedSequenceFloors();
}

async function wireBroadcastHook(){
    const address = await cryptoHelper.getNewFundedAddress(
        'anchor-fold-publisher', COIN, NETWORK, null, 'legacy', 0, 12.0, false
    );
    await regtestMinerConnector.generateBlocks(2);
    await utxoTrackerConnector.quiesce({
        timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector
    });
    const hooks = stageProductionSigner(address);
    // Require the production signer to expose its broadcast path.
    assert.ok(hooks && hooks.broadcastFn, 'production signer exposes a broadcast hook');
    hub.stateAnchorPublisher.setBroadcastHook(async (payload) => {
        const result = await hooks.broadcastFn(payload);
        broadcasts.push({ payload, txid: result.txid, phase1_txid: result.phase1_txid });
        await regtestMinerConnector.generateBlocks(1);
        await utxoTrackerConnector.quiesce({
            timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector
        });
        return result;
    });
}

async function stopHub(){
    if(weightSeed) weightSeed.restore();
    if(mvh){ await mvh.stop(); await mvh.dropDatabases(); }
    if(hubDb) await hubDb.stop();
    if(signerDir) fs.rmSync(signerDir, { recursive: true, force: true });
}

async function stopVenue(){
    try { await venueHooks.afterAll.call(this); }
    finally { restoreManagedEnv(); }
}

async function settleVenue(){
    await venueHooks.afterEach.call(this);
}

async function createCheckpointSet(){
    const indexed = await indexerQuery(
        'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS sequence FROM anchor_actions ' +
        "WHERE chain = 'DOGE' AND network = 'regtest'"
    );
    const local = await hub.db.doQuery(
        "SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS sequence FROM state_checkpoints " +
        "WHERE chain = 'DOGE' AND network = 'regtest'"
    );
    const sequence = Math.max(Number(indexed[0].sequence), Number(local[0].sequence));
    const doge = signedCheckpoint('DOGE', sequence, snapshotBlock);
    await insertCheckpoint(doge);
    const prior = await indexerQuery(
        'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS sequence FROM anchor_actions ' +
        "WHERE chain = 'BTC' AND network = 'regtest'"
    );
    await insertCheckpoint(signedCheckpoint('BTC', Number(prior[0].sequence), Number(doge.snapshot_block)));
    return doge;
}

async function seedCapabilities(snapshotBlock){
    const pubkey = identity.getPubkeyHex().toLowerCase();
    for(const capability of ['oracle_publish', 'cross_chain']){
        await indexerQuery(
            'INSERT INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) ' +
            'VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount), source = VALUES(source)',
            [snapshotBlock, capability, pubkey, '1', pubkey]
        );
        await hub.db.doQuery(
            'INSERT IGNORE INTO capability_snapshots ' +
            '(snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?)',
            [snapshotBlock, capability, pubkey, '1', pubkey]
        );
    }
}

async function insertPendingArchive(snapshotBlock){
    const match = {
        match_id: crypto.randomBytes(32).toString('hex'), snapshot_block: snapshotBlock,
        network: 'regtest', a_chain: 'DOGE', a_action_index: 11, a_kind: 'swap',
        a_tick: 'TOKA', a_amount: '1000', a_filled_before: '0', a_ownership: 0,
        a_payout_addr: 'fold_payout_a', b_chain: 'BTC', b_action_index: 22,
        b_kind: 'swap', b_tick: 'TOKB', b_amount: '2000', b_filled_before: '0',
        b_ownership: 0, b_payout_addr: 'fold_payout_b', effective_time: Math.floor(Date.now() / 1000)
    };
    const signatures = JSON.stringify([{
        pubkey: identity.getPubkeyHex().toLowerCase(),
        sig: identity.sign(hub.crossChainDex.canonicalMatch(match))
    }]);
    await hub.db.doQuery(
        `INSERT INTO cross_chain_matches
            (match_id, snapshot_block, network, a_chain, a_action_index, a_kind, a_tick, a_amount,
             a_filled_before, a_ownership, a_payout_addr, b_chain, b_action_index, b_kind, b_tick,
             b_amount, b_filled_before, b_ownership, b_payout_addr, effective_time,
             validator_signatures, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'finalized')`,
        [match.match_id, match.snapshot_block, match.network, match.a_chain, match.a_action_index,
            match.a_kind, match.a_tick, match.a_amount, match.a_filled_before, match.a_ownership,
            match.a_payout_addr, match.b_chain, match.b_action_index, match.b_kind, match.b_tick,
            match.b_amount, match.b_filled_before, match.b_ownership, match.b_payout_addr,
            match.effective_time, signatures]
    );
}

async function acceptFoldedCycle(){
    const doge = await createCheckpointSet();
    const snapshotBlock = Number(doge.snapshot_block);
    await seedCapabilities(snapshotBlock);
    await insertPendingArchive(snapshotBlock);
    const checkpointRows = await hub.db.doQuery(
        'SELECT chain FROM state_checkpoints WHERE network = ? AND snapshot_block = ? AND anchor_txid IS NULL',
        ['regtest', snapshotBlock]
    );
    const checkpointChains = checkpointRows.map((row) => String(row.chain)).sort();
    // Require at least two checkpointed chains before the single flush.
    assert.ok(checkpointChains.length >= 2, 'the flush has at least two checkpointed chains');
    broadcasts = [];
    await hub.stateAnchorPublisher.flush();
    // Require the checkpoint and archive legs to share one broadcast.
    assert.strictEqual(broadcasts.length, 1, 'one flush published exactly one transaction');
    assert.match(String(broadcasts[0].txid), /^[0-9a-f]{64}$/, 'the folded transaction was broadcast');
    const selected = selectSingleAnchorV3Broadcast(broadcasts.map((item) => item.payload));
    const parsed = parseAnchorV3(broadcasts[0].payload);
    // Require the raw v3 parser and single-broadcast selector to agree.
    assert.deepStrictEqual(parsed, selected, 'the single broadcast parses as ANCHOR v3');
    // Require the wire to carry every checkpoint that entered the flush.
    assert.deepStrictEqual(parsed.sections.map((section) => section.chain).sort(), checkpointChains,
        'every checkpointed chain appears as a v3 section');
    // Require the pending archive to ride the same v3 transaction.
    assert.strictEqual(parsed.archiveCount, 1, 'the v3 wire carries one archive section');
}

(requireFederation ? describe : describe.skip)('ANCHOR fold live acceptance', function(){
    this.timeout(15 * 60 * 1000);
    before(startVenue);
    before(startHub);
    afterEach(settleVenue);
    after(stopHub);
    after(stopVenue);
    it('folds checkpoint sections and one archive into one transaction', acceptFoldedCycle);
});
