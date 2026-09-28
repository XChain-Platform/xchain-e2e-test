'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { encode: wifEncode } = require('wif');

const FOLD_ENV = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION';
const priorFoldEnv = process.env[FOLD_ENV];
process.env[FOLD_ENV] = '0';

const venueHooks = require('../../initialCheck.test.js').mochaHooks;
const cryptoHelper = require('../../cryptoHelper');
const CryptoNetworks = require('../../../src/CryptoNetworks');
const {
    MultiValidatorHub, ValidatorIdentity, loadHubModule, resolveHubFile
} = require('../../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../../helpers/disposableHubDb');
const { seedWeightSnapshot } = require('../../helpers/seededWeightSnapshot');
const { silenceArchiveAttestor } = require('../../helpers/byzantineFaults');
const { parseAnchorV3 } = require('../../helpers/anchor_fold/parse_anchor_v3');

const REQUIRE_FEDERATION = process.env.E2E_REQUIRE_FEDERATION === '1';
const N = 2;
const ARCHIVE_SUBDEADLINE_MS = 10;
const PUBLISH_CADENCE_BOUND_MS = 5000;
const HUB_DB_NAME = 'xchain-anchor-fold-silenced-' + process.pid;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let snapshotBlock = null;
let hubDb = null;
let mvh = null;
let weightSeed = null;
let signerDir = null;
let signerHooks = null;
let SAP = null;
let SCE = null;
let identities = [];
let pubkeys = [];
let broadcasts = [];
let foldRequests = [];
let faultRestores = [];

async function indexerQuery(sql, params){
    const conn = await indexerDatabase.getConnection();
    try { return await conn.query(sql, params); }
    finally { await conn.release(); }
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

async function allHubs(sql, params){
    for(const hub of mvh.hubs) await hub.db.doQuery(sql, params);
}

function stageProductionSigner(addressInfo){
    const example = resolveHubFile('examples/doge-signer.example.js');
    signerDir = path.join(require('os').tmpdir(), 'xchain-fold-silenced-signer-' + process.pid);
    fs.rmSync(signerDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(signerDir, 'node_modules'), { recursive: true });
    fs.copyFileSync(example, path.join(signerDir, 'signer.js'));
    for(const dep of ['xchain-sdk', 'dotenv']){
        let target;
        try { target = path.dirname(require.resolve(dep + '/package.json')); }
        catch(_error){
            target = path.resolve(__dirname, '../../../../', dep);
            if(!fs.existsSync(target)) throw new Error('cannot resolve ' + dep + ' for the staged signer');
        }
        fs.symlinkSync(target, path.join(signerDir, 'node_modules', dep), 'dir');
    }
    const network = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK);
    process.env.DOGE_NETWORK = COIN + '-' + NETWORK;
    process.env.DOGE_ADDRESS = addressInfo.address;
    process.env.DOGE_WIF = wifEncode(network.wif, Buffer.from(addressInfo.privateKey), true);
    process.env.DOGE_ENCODER_URL = 'http://' + (process.env.ENCODER_URL || 'localhost') + ':' +
        (process.env.ENCODER_API_PORT || '3023');
    process.env.HUB_SIGNER_MODULE = path.join(signerDir, 'signer.js');
    const hooks = loadHubModule('src/lib/signer_loader.js').loadSignerHooks(process.env);
    assert.ok(hooks && hooks.broadcastFn, 'the production signer exposes its broadcast hook');
    return hooks;
}

function deliverablePeers(hub){
    let count = 0;
    for(const [, peer] of (hub.peerManager && hub.peerManager.peers) || []){
        if(peer.ws && peer.ws.readyState === 1) count++;
    }
    return count;
}

async function waitForPeers(){
    const deadline = Date.now() + 60000;
    let counts = mvh.hubs.map(deliverablePeers);
    while(Date.now() < deadline && counts.some((count) => count < N - 1)){
        await sleep(250);
        counts = mvh.hubs.map(deliverablePeers);
    }
    return counts;
}

function observePublisher(hub, index){
    const sap = hub.stateAnchorPublisher;
    sap.network = 'regtest';
    sap.roundTimeoutMs = 20000;
    sap.archiveFoldSubdeadlineMs = ARCHIVE_SUBDEADLINE_MS;
    sap.electionToleranceBlocks = 100000;
    sap.indexers = sap.indexers || {};
    sap.indexers.DOGE = { url: indexerConnector.url, key: process.env.INDEXER_API_KEY || '' };
    const handleMessage = sap.handleMessage;
    sap.handleMessage = function (envelope){
        if(envelope && envelope.type === SAP.XANCPUB_SIGN_REQ && envelope.data.archive)
            foldRequests[index]++;
        return handleMessage.call(this, envelope);
    };
    sap.setBroadcastHook(async (payload) => {
        const startedAt = Date.now();
        const result = await signerHooks.broadcastFn(payload);
        broadcasts.push({ hub: index, payload, startedAt, txid: result.txid });
        await regtestMinerConnector.generateBlocks(1);
        await utxoTrackerConnector.quiesce({
            timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector
        });
        return result;
    });
}

async function seedCapabilities(){
    for(const capability of ['oracle_publish', 'cross_chain']){
        for(const pubkey of pubkeys){
            await indexerQuery(
                'INSERT INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) ' +
                'VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount), source = VALUES(source)',
                [snapshotBlock, capability, pubkey, '1', pubkey]);
            await allHubs(
                'INSERT IGNORE INTO capability_snapshots ' +
                '(snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?)',
                [snapshotBlock, capability, pubkey, '1', pubkey]);
        }
    }
}

async function proveFederationReady(){
    for(let i = 0; i < N; i++){
        const sap = mvh.hubs[i].stateAnchorPublisher;
        const eligible = await sap.getActiveOraclePublishPubkeys(snapshotBlock);
        // Keep checkpoint publication on the complete two-validator set.
        assert.deepStrictEqual([...eligible].sort(), [...pubkeys].sort(),
            'hub' + i + ' resolves the complete oracle_publish set');
        const signingSet = await sap.resolveCapabilitySet('oracle_publish', snapshotBlock, 'regtest');
        // Keep stake-weighted quorum sources distinct and non-blank.
        assert.strictEqual(new Set(signingSet.map((row) => String(row.source))).size, N,
            'hub' + i + ' resolves one source per validator');
    }
    const peers = await waitForPeers();
    // Keep the normal bundle-attestation path deliverable while archive replies are silenced.
    assert.ok(peers.every((count) => count >= N - 1),
        'every hub has an open peer connection: ' + JSON.stringify(peers));
}

async function seedBatchFloor(){
    const rows = await indexerQuery(
        'SELECT MAX(match_batch_seq) AS max_batch FROM anchor_actions ' +
        'WHERE match_batch_seq IS NOT NULL AND version <> 2');
    const maxBatch = rows[0] && rows[0].max_batch;
    if(maxBatch == null) return;
    await allHubs(
        `INSERT IGNORE INTO cross_chain_matches
            (match_id, snapshot_block, network, a_chain, a_action_index, a_tick, a_amount, a_payout_addr,
             b_chain, b_action_index, b_tick, b_amount, b_payout_addr, effective_time,
             validator_signatures, status, batch_seq, archived_status)
         VALUES ('fold-silenced-seq-floor', ?, 'regtest', 'DOGE', 0, 'X', '0', 'x',
                 'LTC', 0, 'X', '0', 'x', 0, '[]', 'finalized', ?, 'finalized')`,
        [snapshotBlock, Number(maxBatch)]);
}

async function startFederation(){
    snapshotBlock = await indexedBtcBlock();
    process.env.XDEX_SNAPSHOT_BLOCK = String(snapshotBlock);
    mvh = new MultiValidatorHub({
        count: N,
        basePort: 35000 + (process.pid % 400),
        startCrossChain: true,
        startAttestation: false,
        dbNamePrefix: 'XChain_DOGE_Regtest_Fold_Silenced_' + process.pid + '_'
    });
    await mvh.start();
    identities = mvh.identities.map((item) => new ValidatorIdentity(item.privkeyHex));
    pubkeys = mvh.getPubkeys().map((pubkey) => pubkey.toLowerCase());
    mvh.hubs.forEach((hub) => { hub.peerManager.effectiveSignerSet = new Set(pubkeys); });
    foldRequests = Array(N).fill(0);
    weightSeed = seedWeightSnapshot(mvh, { blockIndex: snapshotBlock, network: 'regtest' });
    mvh.hubs.forEach(observePublisher);
    await seedCapabilities();
    await proveFederationReady();
    await seedBatchFloor();
}

async function nextCheckpointSeq(){
    const rows = await indexerQuery(
        "SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS seq FROM anchor_actions " +
        "WHERE chain = 'DOGE' AND network = 'regtest'");
    return Number(rows[0].seq);
}

function signedCheckpoint(seq){
    const row = {
        chain: 'DOGE', network: 'regtest', block_index: 100000 + seq,
        block_hash: crypto.randomBytes(32).toString('hex'),
        ledger_hash: crypto.randomBytes(32).toString('hex'),
        actions_hash: crypto.randomBytes(32).toString('hex'),
        contract_hash: crypto.randomBytes(32).toString('hex'),
        checkpoint_seq: seq, snapshot_block: snapshotBlock,
        state_root: crypto.randomBytes(32).toString('hex'), state_root_version: 1,
        block_merkle_root: crypto.randomBytes(32).toString('hex'), block_merkle_version: 1
    };
    row.validator_signatures = JSON.stringify(identities.map((identity) => ({
        pubkey: identity.getPubkeyHex().toLowerCase(),
        sig: identity.sign(SCE.canonicalCheckpoint(row))
    })));
    return row;
}

async function insertCheckpoint(row){
    await allHubs(
        'INSERT INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, actions_hash, ' +
        'contract_hash, checkpoint_seq, snapshot_block, validator_signatures, state_root, state_root_version, ' +
        'block_merkle_root, block_merkle_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [row.chain, row.network, row.block_index, row.block_hash, row.ledger_hash, row.actions_hash,
         row.contract_hash, row.checkpoint_seq, row.snapshot_block, row.validator_signatures,
         row.state_root, row.state_root_version, row.block_merkle_root, row.block_merkle_version]);
}

async function insertPendingMatch(){
    const row = {
        match_id: crypto.randomBytes(32).toString('hex'), snapshot_block: snapshotBlock, network: 'regtest',
        a_chain: 'DOGE', a_action_index: 11, a_kind: 'swap', a_tick: 'TOKA', a_amount: '1000',
        a_filled_before: '0', a_ownership: 0, a_payout_addr: 'fold_payout_a',
        b_chain: 'LTC', b_action_index: 22, b_kind: 'swap', b_tick: 'TOKB', b_amount: '2000',
        b_filled_before: '0', b_ownership: 0, b_payout_addr: 'fold_payout_b',
        effective_time: Math.floor(Date.now() / 1000)
    };
    const canonical = mvh.hubs[0].getCrossChainDex().canonicalMatch(row);
    const signatures = JSON.stringify(identities.map((identity) => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical)
    })));
    await allHubs(
        `INSERT INTO cross_chain_matches
            (match_id, snapshot_block, network, a_chain, a_action_index, a_kind, a_tick, a_amount,
             a_filled_before, a_ownership, a_payout_addr, b_chain, b_action_index, b_kind, b_tick,
             b_amount, b_filled_before, b_ownership, b_payout_addr, effective_time,
             validator_signatures, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'finalized')`,
        [row.match_id, row.snapshot_block, row.network, row.a_chain, row.a_action_index, row.a_kind,
         row.a_tick, row.a_amount, row.a_filled_before, row.a_ownership, row.a_payout_addr, row.b_chain,
         row.b_action_index, row.b_kind, row.b_tick, row.b_amount, row.b_filled_before, row.b_ownership,
         row.b_payout_addr, row.effective_time, signatures]);
}

function bundleLeader(){
    const key = mvh.hubs[0].stateAnchorPublisher.bundleElectionKey({
        network: 'regtest', snapshot_block: snapshotBlock
    });
    return pubkeys.indexOf(SAP.hashOrder(key, pubkeys)[0]);
}

function silenceFoldArchiveCosigner(hub){
    const restoreLegacy = silenceArchiveAttestor(hub);
    const sap = hub.stateAnchorPublisher;
    const original = sap.coSignFoldArchiveRequest;
    sap.coSignFoldArchiveRequest = async () => null;
    return () => {
        sap.coSignFoldArchiveRequest = original;
        restoreLegacy();
    };
}

async function driveAcceptance(){
    await startFederation();
    const checkpoint = signedCheckpoint(await nextCheckpointSeq());
    await insertCheckpoint(checkpoint);
    await insertPendingMatch();
    const leader = bundleLeader();
    const cosigners = mvh.hubs.map((_hub, index) => index).filter((index) => index !== leader);
    faultRestores = cosigners.map((index) => silenceFoldArchiveCosigner(mvh.hubs[index]));

    const flushStartedAt = Date.now();
    await mvh.hubs[leader].stateAnchorPublisher.flush();
    const parsed = broadcasts.map((entry) => ({ entry, parsed: parseAnchorV3(entry.payload) }))
        .filter((item) => item.parsed !== null);
    // Publish exactly one folded checkpoint transaction for this cycle.
    assert.strictEqual(parsed.length, 1, 'one v3 transaction was broadcast');
    assert.match(String(parsed[0].entry.txid), /^[0-9a-f]{64}$/, 'the checkpoint transaction was broadcast');
    // Drop only the archive section after its co-signers stay silent.
    assert.strictEqual(parsed[0].parsed.archiveCount, 0, 'the v3 wire carries ARCHIVE_COUNT 0');
    assert.strictEqual(parsed[0].parsed.archive, null, 'the v3 wire carries no archive fields');
    // Prove the archive attempt reached a silenced co-signer before the fallback.
    assert.ok(cosigners.every((index) => foldRequests[index] >= 1),
        'every archive co-signer received the folded archive request');
    const publishDelay = parsed[0].entry.startedAt - flushStartedAt;
    // Keep the checkpoint publish on the short fold cadence, not the legacy round timeout.
    assert.ok(publishDelay <= PUBLISH_CADENCE_BOUND_MS,
        'checkpoint publish took ' + publishDelay + 'ms, bound ' + PUBLISH_CADENCE_BOUND_MS + 'ms');
    console.log('    folded checkpoint ' + parsed[0].entry.txid + ' published in ' + publishDelay +
        'ms with ARCHIVE_COUNT 0');
}

async function cleanup(){
    for(const restore of faultRestores.splice(0)) restore();
    if(weightSeed){ weightSeed.restore(); weightSeed = null; }
    if(mvh){ await mvh.stop(); await mvh.dropDatabases(); mvh = null; }
    if(hubDb){ await hubDb.stop(); hubDb = null; }
    if(signerDir) fs.rmSync(signerDir, { recursive: true, force: true });
    delete process.env.DOGE_WIF;
    delete process.env.HUB_SIGNER_MODULE;
    if(priorFoldEnv === undefined) delete process.env[FOLD_ENV];
    else process.env[FOLD_ENV] = priorFoldEnv;
}

function registerSuite(){
    this.timeout(30 * 60 * 1000);

    before(async function () {
        await venueHooks.beforeAll.call(this);
        process.env.CHECKPOINT_CHAINS = 'DOGE';
        process.env.CHECKPOINT_POLL_MS = '600000000';
        process.env.ANCHOR_INTERVAL_MS = '600000000';
        process.env.ANCHOR_ELECTION_TOLERANCE_BLOCKS = '100000';
        delete process.env.XDEX_SEED_LOCAL_VALIDATOR;
        process.env.XCHAIN_CONFIRMATIONS_DOGE = '1';
        hubDb = await startDisposableHubDb({ forceDocker: true, name: HUB_DB_NAME });
        if(!hubDb){
            console.log('Skipping ANCHOR fold archive-silenced acceptance: no Docker available for the disposable hub DB');
            this.skip();
        }
        SAP = loadHubModule('src/anchor/publisher.js');
        SCE = loadHubModule('src/anchor/checkpoint_engine.js');
        const address = await cryptoHelper.getNewFundedAddress(
            'anchor-fold-silenced-publisher', COIN, NETWORK, null, 'legacy', 0, 12.0, false);
        await regtestMinerConnector.generateBlocks(2);
        await utxoTrackerConnector.quiesce({
            timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector
        });
        signerHooks = stageProductionSigner(address);
    });

    afterEach(async function () {
        await venueHooks.afterEach.call(this);
    });

    after(async function () {
        try { await cleanup(); }
        finally { await venueHooks.afterAll.call(this); }
    });

    it('publishes the checkpoint on cadence with no archive section', driveAcceptance);
}

if(!REQUIRE_FEDERATION){
    console.log('Skipping ANCHOR fold archive-silenced acceptance: set E2E_REQUIRE_FEDERATION=1 to run');
}

(REQUIRE_FEDERATION ? describe : describe.skip)(
    'ANCHOR fold acceptance: archive co-signers silenced', registerSuite);
