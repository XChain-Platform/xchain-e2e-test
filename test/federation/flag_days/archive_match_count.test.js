'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { encode: wifEncode } = require('wif');

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
const { archiveCountCases } = require('../../helpers/flag_days/archive_count_cases');
const { unusedBtcSnapshotBlock, pinMeshSignerSet } = require('../../helpers/flag_days/snapshot_block');

const MATCHES_LENGTH = 3;
const CASES = archiveCountCases(MATCHES_LENGTH);
const MATCH_COUNT_GATE = 'archive_match_count_activation.ARCHIVE_MATCH_COUNT_ACTIVATION';
const HUB_DB_PORT = 14000 + (process.pid % 300);
const HUB_DB_NAME = 'xchain-archive-count-hubdb-' + process.pid;
// Set in setup to an unused committed BTC block (ARCHIVE_COUNT_SNAPSHOT_BLOCK pins one).
let SNAPSHOT_BLOCK = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let hubDb = null;
let mvh = null;
let publisher = null;
let identities = [];
let weightSeed = null;
let signerDir = null;
let signerHooks = null;
let checkpointSeqBase = 0;
let batchSeqBase = 0;

function indexerGateRegistryPath(){
    const relative = path.join('src', 'consensus', 'gate_registry.js');
    const candidates = [
        process.env.XCHAIN_INDEXER_PATH && path.join(process.env.XCHAIN_INDEXER_PATH, relative),
        process.env.XCHAIN_INDEXER_DIR && path.join(process.env.XCHAIN_INDEXER_DIR, relative),
        path.resolve(__dirname, '../../../xchain-indexer', relative),
        path.resolve(__dirname, '../../../../xchain-indexer', relative),
        path.resolve(__dirname, '../../../../../xchain-indexer', relative),
        path.resolve(__dirname, '../../../../../../modules/xchain-indexer', relative)
    ].filter(Boolean);
    const resolved = candidates.find((candidate) => fs.existsSync(candidate));
    if(resolved) return resolved;
    throw new Error('cannot resolve the xchain-indexer gate registry; tried: ' +
        candidates.join(', '));
}

function assertMatchCountGateArmed(){
    const gates = require(indexerGateRegistryPath());
    const activation = gates.copy(MATCH_COUNT_GATE);
    assert.strictEqual(activation.regtest, 0,
        'the archive MATCH_COUNT rail requires regtest activation at height 0');
    assert.strictEqual(gates.activeAt(MATCH_COUNT_GATE, 'regtest', null, 0, null), true,
        'the archive MATCH_COUNT rule must be active from the regtest genesis block');
}

assertMatchCountGateArmed();

async function indexerQuery(sql, params){
    const conn = await indexerDatabase.getConnection();
    try { return await conn.query(sql, params); }
    finally { await conn.release(); }
}

function signerDependencyPath(dep){
    try { return path.dirname(require.resolve(dep + '/package.json')); }
    catch(e){
        const target = path.resolve(__dirname, '../../../', dep);
        if(!fs.existsSync(target)) throw e;
        return target;
    }
}

function stageProductionSigner(addressInfo){
    signerDir = path.join(require('os').tmpdir(), 'xchain-archive-count-signer-' + process.pid);
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
    assert.ok(status && status.ready, 'the UTXO tracker settled after the archive broadcast');
}

async function seedCapabilityRows(){
    const pubkeys = identities.map((identity) => identity.getPubkeyHex().toLowerCase());
    for(const capability of ['oracle_publish', 'cross_chain']){
        for(let i = 0; i < pubkeys.length; i++){
            await indexerQuery(
                'INSERT INTO capability_snapshots ' +
                '(snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?) ' +
                'ON DUPLICATE KEY UPDATE amount = VALUES(amount), source = VALUES(source)',
                [SNAPSHOT_BLOCK, capability, pubkeys[i], '1000', 'src' + i]
            );
        }
    }
    const rows = await indexerQuery(
        'SELECT capability FROM capability_snapshots WHERE snapshot_block = ?', [SNAPSHOT_BLOCK]);
    assert.strictEqual(rows.length, 2 * pubkeys.length,
        'both seeded validators are mirrored in both capability sets');
}

async function nextSequenceBases(){
    const rows = await indexerQuery(
        `SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS checkpoint_seq,
                COALESCE(MAX(match_batch_seq), -1) + 1 AS batch_seq
         FROM anchor_actions`);
    checkpointSeqBase = Number(rows[0].checkpoint_seq);
    batchSeqBase = Number(rows[0].batch_seq);
}

function checkpointFor(caseIndex){
    return {
        chain: 'DOGE',
        network: 'regtest',
        block_index: 1800000 + caseIndex,
        block_hash: crypto.randomBytes(32).toString('hex'),
        ledger_hash: crypto.randomBytes(32).toString('hex'),
        actions_hash: crypto.randomBytes(32).toString('hex'),
        contract_hash: crypto.randomBytes(32).toString('hex'),
        checkpoint_seq: checkpointSeqBase + caseIndex,
        snapshot_block: SNAPSHOT_BLOCK
    };
}

function signedMatches(caseIndex){
    const dex = mvh.hubs[0].getCrossChainDex();
    return Array.from({ length: MATCHES_LENGTH }, (_, matchIndex) => {
        const match = {
            match_id: crypto.createHash('sha256')
                .update('archive-count-' + process.pid + '-' + caseIndex + '-' + matchIndex).digest('hex'),
            snapshot_block: SNAPSHOT_BLOCK,
            network: 'regtest',
            a_chain: 'DOGE', a_action_index: 100 + matchIndex, a_kind: 'swap',
            a_tick: 'TOKA', a_amount: '1000', a_filled_before: '0', a_ownership: 0,
            a_payout_addr: 'archive_count_a_' + matchIndex,
            b_chain: 'LTC', b_action_index: 200 + matchIndex, b_kind: 'swap',
            b_tick: 'TOKB', b_amount: '2000', b_filled_before: '0', b_ownership: 0,
            b_payout_addr: 'archive_count_b_' + matchIndex,
            effective_time: 1800000000 + matchIndex,
            status: 'finalized'
        };
        const canonical = dex.canonicalMatch(match);
        match.validator_signatures = JSON.stringify(identities.map((identity) => ({
            pubkey: identity.getPubkeyHex().toLowerCase(),
            sig: identity.sign(canonical)
        })));
        return match;
    });
}

async function wireFor(testCase, caseIndex){
    const cp = checkpointFor(caseIndex);
    const batchSeq = batchSeqBase + caseIndex;
    const archive = await publisher.buildArchive(
        'regtest', batchSeq, signedMatches(caseIndex), SNAPSHOT_BLOCK, [], [], {});
    assert.strictEqual(archive.count, MATCHES_LENGTH,
        'the archive body contains the fixture match count before the wire override');
    assert.strictEqual(JSON.parse(archive.json).matches.length, MATCHES_LENGTH,
        'the CRC-bearing JSON contains exactly the fixture matches');
    const productionWire = publisher.archiveWire(archive.json);
    const splitAt = Math.ceil(productionWire.b64.length / 2);
    const chunks = [
        productionWire.b64.slice(0, splitAt),
        productionWire.b64.slice(splitAt)
    ];
    const canonical = publisher.archiveCanonical(
        cp, batchSeq, testCase.matchCount, productionWire.crc, chunks.length);
    const signatures = identities.map((identity) => ({
        pubkey: identity.getPubkeyHex().toLowerCase(),
        sig: identity.sign(canonical)
    }));
    const round = { batchSeq, count: testCase.matchCount, crc: productionWire.crc, chunks };
    const payload = publisher.archiveHeadPayload(
        cp, round, signatures, identities[0].getPubkeyHex(), []);
    return { cp, batchSeq, chunks, payload };
}

async function broadcast(payload){
    const result = await signerHooks.broadcastFn(payload);
    assert.ok(result && result.txid, 'the archive payload published with a reveal txid');
    assert.ok(result.phase1_txid, 'the archive payload published with a funding txid');
    assert.notStrictEqual(result.phase1_txid, result.txid,
        'the production signer used distinct funding and reveal transactions');
    await settleTracker();
    return result;
}

async function publishArchiveCase(testCase, caseIndex){
    const wire = await wireFor(testCase, caseIndex);
    await broadcast(wire.payload);
    for(let i = 1; i < wire.chunks.length; i++)
        await broadcast(['ANCHOR', '2', wire.batchSeq, i, wire.chunks.length, wire.chunks[i]].join('|'));
    return wire;
}

async function waitForStatus(wire, expected){
    const deadline = Date.now() + 180000;
    let observed = null;
    while(Date.now() < deadline){
        const rows = await indexerQuery(
            `SELECT a.action_index, s.status,
                    (SELECT COUNT(*) FROM anchor_actions c
                     WHERE c.version = 2 AND c.match_batch_seq = ?) AS chunk_count
             FROM anchor_actions a
             LEFT JOIN index_statuses s ON s.id = a.status_id
             WHERE a.version = 1 AND a.ledger_hash = ? AND a.match_batch_seq = ?
             ORDER BY a.action_index DESC LIMIT 1`,
            [wire.batchSeq, wire.cp.ledger_hash, wire.batchSeq]);
        if(rows.length) observed = rows[0];
        if(observed && Number(observed.chunk_count) === wire.chunks.length - 1 &&
           String(observed.status) === expected) return observed;
        await regtestMinerConnector.generateBlocks(1);
        await sleep(2000);
    }
    assert.fail('archive batch ' + wire.batchSeq + ' expected status ' + expected +
        ', observed ' + JSON.stringify(observed));
}

async function setup(){
    SNAPSHOT_BLOCK = await unusedBtcSnapshotBlock({
        indexerQuery, override: process.env.ARCHIVE_COUNT_SNAPSHOT_BLOCK
    });
    process.env.XDEX_SNAPSHOT_BLOCK = String(SNAPSHOT_BLOCK);
    process.env.CHECKPOINT_CHAINS = 'DOGE';
    process.env.CHECKPOINT_POLL_MS = '600000000';
    process.env.ANCHOR_INTERVAL_MS = '600000000';
    process.env.XCHAIN_CONFIRMATIONS_DOGE = '1';
    if(!process.env.DOGE_INDEXER_URL)
        process.env.DOGE_INDEXER_URL = 'http://localhost:' +
            (process.env.INDEXER_API_PORT || '3124');

    hubDb = await startDisposableHubDb({
        forceDocker: true,
        port: HUB_DB_PORT,
        name: HUB_DB_NAME
    });
    assert.ok(hubDb, 'the archive rail requires a disposable hub database');
    mvh = new MultiValidatorHub({
        count: 2,
        basePort: 61300 + (process.pid % 100),
        startCrossChain: true,
        startAttestation: false,
        dbNamePrefix: 'XChain_DOGE_Regtest_ARCHCOUNT_' + process.pid + '_'
    });
    await mvh.start();
    identities = mvh.identities.map((identity) => new ValidatorIdentity(identity.privkeyHex));
    weightSeed = seedWeightSnapshot(mvh, { blockIndex: SNAPSHOT_BLOCK, network: 'regtest' });
    pinMeshSignerSet(mvh);
    publisher = mvh.hubs[0].stateAnchorPublisher;
    publisher.network = 'regtest';
    publisher.indexers = publisher.indexers || {};
    publisher.indexers.DOGE = {
        url: process.env.DOGE_INDEXER_URL,
        key: process.env.INDEXER_API_KEY || ''
    };
    await seedCapabilityRows();
    await nextSequenceBases();

    // Funds native coin only: the publisher pays no XCHAIN, and the DOGE gas seed is a bridge.
    const addressInfo = await cryptoHelper.getNewFundedAddress(
        'archive-count-publisher', COIN, NETWORK, null, 'legacy', 0, 10.0, false);
    await settleTracker();
    signerHooks = stageProductionSigner(addressInfo);
    assert.ok(signerHooks && signerHooks.broadcastFn,
        'the production DOGE signer exposes its broadcast hook');
}

async function teardown(){
    // Removes the capability rows seeded at a real BTC block.
    if(identities.length && SNAPSHOT_BLOCK !== null){
        for(const identity of identities)
            await indexerQuery(
                "DELETE FROM capability_snapshots WHERE snapshot_block = ? AND signing_pubkey = ? " +
                "AND capability IN ('oracle_publish', 'cross_chain')",
                [SNAPSHOT_BLOCK, identity.getPubkeyHex().toLowerCase()]);
    }
    if(weightSeed) weightSeed.restore();
    if(mvh){ await mvh.stop(); await mvh.dropDatabases(); }
    if(hubDb) await hubDb.stop();
    if(signerDir) fs.rmSync(signerDir, { recursive: true, force: true });
    delete process.env.DOGE_WIF;
    delete process.env.HUB_SIGNER_MODULE;
}

describe('ANCHOR archive MATCH_COUNT flag day on DOGE regtest', function () {
    this.timeout(15 * 60 * 1000);

    before(setup);
    after(teardown);

    for(const [caseIndex, testCase] of CASES.entries()){
        it('stores the ' + testCase.name + ' MATCH_COUNT archive as ' + testCase.expect,
            async function () {
                const wire = await publishArchiveCase(testCase, caseIndex);
                const row = await waitForStatus(wire, testCase.expect);
                assert.strictEqual(String(row.status), testCase.expect);
            });
    }
});
