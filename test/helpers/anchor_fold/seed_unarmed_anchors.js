'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Puts pre-fold anchors on the DOGE regtest chain for AF4's replay.
//
// AF4 replays the chain and needs at least one ANCHOR v0 bundle row and one v1 or v2
// archive row. A fresh rail chain carries none: the standing hub is an observer whose
// key is not in the seeded signer set and whose one startup flush runs before the DOGE
// indexer resolves (R-3 attempt 4 gap B). So AF4 publishes its own, the way AF1 does,
// with one in-process hub (which takes the seeded roster key on a seeded federation run,
// E-3-fold-signers) and its fold switched off, so the flush takes the legacy path: one
// v0 bundle and a separate v1 archive head, each paid by a funded DOGE publisher.
//
// Needs the venue globals initialCheck sets up (COIN, NETWORK, indexerDatabase,
// regtestMinerConnector, utxoTrackerConnector) on the DOGE regtest venue.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encode: wifEncode } = require('wif');

const cryptoHelper = require('../../cryptoHelper');
const CryptoNetworks = require('../../../src/CryptoNetworks');
const { MultiValidatorHub, ValidatorIdentity, loadHubModule, resolveHubFile } = require('../multiValidatorHubHelper');
const { startDisposableHubDb } = require('../disposableHubDb');
const { seedWeightSnapshot } = require('../seededWeightSnapshot');
const { anchorPayloadVersion } = require('../anchorVersionHelper');

const FOLD_ENV = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION';
const FOLD_OFF_HEIGHT = '999999999';
const MANAGED_ENV = [
    FOLD_ENV, 'XDEX_SEED_LOCAL_VALIDATOR', 'XDEX_SNAPSHOT_BLOCK', 'CHECKPOINT_CHAINS',
    'CHECKPOINT_CONFIRMATIONS', 'CHECKPOINT_POLL_MS', 'ANCHOR_INTERVAL_MS',
    'XCHAIN_CONFIRMATIONS_DOGE', 'DOGE_INDEXER_URL', 'DOGE_NETWORK', 'DOGE_ADDRESS', 'DOGE_WIF',
    'DOGE_ENCODER_URL', 'HUB_SIGNER_MODULE'
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// v0 is the checkpoint bundle; v1 the archive head and v2 its continuation chunks.
function seededVersions(broadcasts){
    const versions = new Set(broadcasts.map((item) => anchorPayloadVersion(item.payload)));
    return { bundle: versions.has(0), archive: versions.has(1) || versions.has(2) };
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

async function unusedSnapshotBlock(){
    const latest = await indexedBtcBlock();
    const floor = Math.max(0, latest - 1024);
    const ceiling = Math.max(0, latest - 12);
    const rows = await indexerQuery(
        'SELECT DISTINCT snapshot_block FROM capability_snapshots WHERE snapshot_block BETWEEN ? AND ?',
        [floor, ceiling]
    );
    const occupied = new Set(rows.map((row) => Number(row.snapshot_block)));
    for(let candidate = ceiling; candidate >= floor; candidate--){
        if(!occupied.has(candidate)) return candidate;
    }
    assert.fail('no unused BTC snapshot block is available for the AF4 seed fixture');
}

class UnarmedAnchorSeed {
    constructor(){
        this.priorEnv = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
        this.broadcasts = [];
        this.snapshotBlock = null;
        this.hubDb = null;
        this.mvh = null;
        this.hub = null;
        this.identity = null;
        this.weightSeed = null;
        this.signerDir = null;
        this.checkpointEngine = null;
        this.seededBlocks = new Set();
    }

    async start(){
        process.env[FOLD_ENV] = FOLD_OFF_HEIGHT;
        // An earlier fold suite can leave its own publisher wallet in the environment, and a
        // hub that boots with it reads that drained address for the balance gate (R-3 attempt
        // 5: 9.992 DOGE below the 10 DOGE floor). Boot without one, as AF1 does; the staged
        // signer below sets this seed's own.
        for(const key of ['DOGE_ADDRESS', 'DOGE_WIF', 'DOGE_NETWORK', 'DOGE_ENCODER_URL', 'HUB_SIGNER_MODULE'])
            delete process.env[key];
        this.snapshotBlock = await unusedSnapshotBlock();
        process.env.XDEX_SEED_LOCAL_VALIDATOR = '1';
        process.env.XDEX_SNAPSHOT_BLOCK = String(this.snapshotBlock);
        process.env.CHECKPOINT_CHAINS = 'DOGE';
        process.env.CHECKPOINT_CONFIRMATIONS = '2';
        process.env.CHECKPOINT_POLL_MS = '600000';
        process.env.ANCHOR_INTERVAL_MS = '600000000';
        process.env.XCHAIN_CONFIRMATIONS_DOGE = '1';
        if(!process.env.DOGE_INDEXER_URL)
            process.env.DOGE_INDEXER_URL = 'http://localhost:' + (process.env.INDEXER_API_PORT || '3124');
        this.hubDb = await startDisposableHubDb({ forceDocker: true, name: 'xchain-anchor-fold-af4-seed-' + process.pid });
        assert.ok(this.hubDb, 'Docker is required for the AF4 seed hub DB');
        this.mvh = new MultiValidatorHub({
            count: 1, basePort: 34760, startCrossChain: true, startAttestation: false,
            dbNamePrefix: 'XChain_DOGE_Regtest_Anchor_Fold_AF4_' + process.pid + '_'
        });
        await this.mvh.start();
        // MultiValidatorHub re-applies the captured arm heights when it starts, so the
        // fold goes off again here, after it, for every flush this seed makes.
        process.env[FOLD_ENV] = FOLD_OFF_HEIGHT;
        this.hub = this.mvh.hubs[0];
        this.identity = new ValidatorIdentity(this.mvh.identities[0].privkeyHex);
        this.hub.peerManager.setEffectiveSignerSet = () => {};
        this.hub.peerManager.effectiveSignerSet = new Set([this.identity.getPubkeyHex().toLowerCase()]);
        this.checkpointEngine = loadHubModule('src/anchor/checkpoint_engine.js');
        this.weightSeed = seedWeightSnapshot(this.mvh, { blockIndex: this.snapshotBlock, network: 'regtest' });
        this.hub.stateAnchorPublisher.network = 'regtest';
        await this.wireBroadcastHook();
        await this.seedArchiveFloor();
    }

    stageProductionSigner(addressInfo){
        this.signerDir = path.join(os.tmpdir(), 'xchain-anchor-fold-af4-signer-' + process.pid);
        fs.rmSync(this.signerDir, { recursive: true, force: true });
        fs.mkdirSync(path.join(this.signerDir, 'node_modules'), { recursive: true });
        fs.copyFileSync(resolveHubFile('examples/doge-signer.example.js'), path.join(this.signerDir, 'signer.js'));
        for(const dependency of ['xchain-sdk', 'dotenv']){
            let target;
            try { target = path.dirname(require.resolve(dependency + '/package.json')); }
            catch(internal){ target = path.resolve(__dirname, '../../../../', dependency); }
            fs.symlinkSync(target, path.join(this.signerDir, 'node_modules', dependency), 'dir');
        }
        const network = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK);
        process.env.DOGE_NETWORK = COIN + '-' + NETWORK;
        process.env.DOGE_ADDRESS = addressInfo.address;
        process.env.DOGE_WIF = wifEncode(network.wif, Buffer.from(addressInfo.privateKey), true);
        process.env.DOGE_ENCODER_URL = 'http://' + (process.env.ENCODER_URL || 'localhost') + ':' +
            (process.env.ENCODER_API_PORT || '3023');
        process.env.HUB_SIGNER_MODULE = path.join(this.signerDir, 'signer.js');
        return loadHubModule('src/lib/signer_loader.js').loadSignerHooks(process.env);
    }

    async wireBroadcastHook(){
        const address = await cryptoHelper.getNewFundedAddress(
            'anchor-fold-af4-publisher', COIN, NETWORK, null, 'legacy', 0, 25.0, false
        );
        await regtestMinerConnector.generateBlocks(2);
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
        const hooks = this.stageProductionSigner(address);
        assert.ok(hooks && hooks.broadcastFn, 'production signer exposes a broadcast hook');
        this.hub.stateAnchorPublisher.setBroadcastHook(async (payload) => {
            const result = await hooks.broadcastFn(payload);
            this.broadcasts.push({ payload, txid: result.txid });
            await regtestMinerConnector.generateBlocks(1);
            await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
            return result;
        });
    }

    async seedArchiveFloor(){
        const prior = await indexerQuery(
            'SELECT MAX(match_batch_seq) AS max_batch FROM anchor_actions ' +
            'WHERE match_batch_seq IS NOT NULL AND version <> 2'
        );
        if(prior[0].max_batch == null) return;
        await this.hub.db.doQuery(
            `INSERT INTO cross_chain_matches
                (match_id, snapshot_block, network, a_chain, a_action_index, a_tick, a_amount, a_payout_addr,
                 b_chain, b_action_index, b_tick, b_amount, b_payout_addr, effective_time,
                 validator_signatures, status, batch_seq, archived_status)
             VALUES ('seq-baseline', ?, 'regtest', 'DOGE', 0, 'X', '0', 'x', 'BTC', 0, 'X', '0', 'x', 0,
                     '[]', 'finalized', ?, 'finalized')`,
            [this.snapshotBlock, Number(prior[0].max_batch)]
        );
    }

    signedCheckpoint(chain, sequence, snapshotBlock){
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
            pubkey: this.identity.getPubkeyHex().toLowerCase(),
            sig: this.identity.sign(this.checkpointEngine.canonicalCheckpoint(row))
        }]);
        return row;
    }

    async insertCheckpoint(row){
        await this.hub.db.doQuery(
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

    async nextSequence(chain){
        const rows = await indexerQuery(
            'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS sequence FROM anchor_actions ' +
            'WHERE chain = ? AND network = ?', [chain, 'regtest']
        );
        return Number(rows[0].sequence);
    }

    async seedCapabilities(snapshotBlock){
        this.seededBlocks.add(snapshotBlock);
        const pubkey = this.identity.getPubkeyHex().toLowerCase();
        await indexerQuery(
            'INSERT INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) ' +
            'VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount), source = VALUES(source)',
            [snapshotBlock, 'oracle_publish', pubkey, '1', pubkey]
        );
        for(const capability of ['oracle_publish', 'cross_chain']){
            await this.hub.db.doQuery(
                'INSERT IGNORE INTO capability_snapshots ' +
                '(snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?)',
                [snapshotBlock, capability, pubkey, '1', pubkey]
            );
        }
    }

    async insertPendingArchive(snapshotBlock){
        const match = {
            match_id: crypto.randomBytes(32).toString('hex'), snapshot_block: snapshotBlock,
            network: 'regtest', a_chain: 'DOGE', a_action_index: 11, a_kind: 'swap',
            a_tick: 'TOKA', a_amount: '1000', a_filled_before: '0', a_ownership: 0,
            a_payout_addr: 'af4_payout_a', b_chain: 'BTC', b_action_index: 22,
            b_kind: 'swap', b_tick: 'TOKB', b_amount: '2000', b_filled_before: '0',
            b_ownership: 0, b_payout_addr: 'af4_payout_b', effective_time: Math.floor(Date.now() / 1000)
        };
        const signatures = JSON.stringify([{
            pubkey: this.identity.getPubkeyHex().toLowerCase(),
            sig: this.identity.sign(this.hub.crossChainDex.canonicalMatch(match))
        }]);
        await this.hub.db.doQuery(
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

    // One unarmed cycle: a hub-made DOGE checkpoint plus signed BTC and DOGE sections and
    // one pending match, flushed until both the v0 bundle and the archive are broadcast.
    async publishCycle(){
        await this.hub.stateCheckpoints.tick();
        const dogeRows = await this.hub.db.doQuery(
            "SELECT * FROM state_checkpoints WHERE chain = 'DOGE' AND network = 'regtest' " +
            'AND snapshot_block = ? AND anchor_txid IS NULL', [this.snapshotBlock]
        );
        assert.ok(dogeRows.length >= 1, 'the AF4 seed hub produced a DOGE checkpoint');
        const snapshotBlock = Number(dogeRows[0].snapshot_block);
        await this.insertCheckpoint(this.signedCheckpoint('BTC', await this.nextSequence('BTC'), snapshotBlock));
        await this.insertCheckpoint(this.signedCheckpoint('DOGE', await this.nextSequence('DOGE'), snapshotBlock));
        await this.seedCapabilities(snapshotBlock);
        await this.insertPendingArchive(snapshotBlock);

        const summaries = [];
        const deadline = Date.now() + 5 * 60 * 1000;
        let seen = seededVersions(this.broadcasts);
        while(Date.now() < deadline && !(seen.bundle && seen.archive)){
            process.env[FOLD_ENV] = FOLD_OFF_HEIGHT;
            summaries.push(await this.hub.stateAnchorPublisher.flush());
            for(let i = 0; i < 30 && !(seen.bundle && seen.archive); i++){
                await sleep(1000);
                seen = seededVersions(this.broadcasts);
            }
        }
        assert.ok(seen.bundle && seen.archive, 'the AF4 seed published a v0 bundle and a v1 or v2 archive ' +
            '(broadcast versions ' + JSON.stringify(this.broadcasts.map((item) => anchorPayloadVersion(item.payload))) +
            ', flush summaries ' + JSON.stringify(summaries) + ')');
        await regtestMinerConnector.generateBlocks(3);
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
        for(const item of this.broadcasts) await this.waitIndexed(item.txid);
        return this.broadcasts.map((item) => ({ version: anchorPayloadVersion(item.payload), txid: item.txid }));
    }

    async waitIndexed(txid){
        for(let attempt = 0; attempt < 60; attempt++){
            const rows = await indexerQuery(
                `SELECT a.version FROM index_transactions it
                 JOIN transactions t ON t.tx_hash_id = it.id
                 JOIN actions ac ON ac.tx_index = t.tx_index
                 JOIN anchor_actions a ON a.action_index = ac.action_index
                 WHERE it.hash = ?`, [txid]
            );
            if(rows.length) return rows;
            await sleep(2000);
        }
        assert.fail('the DOGE indexer did not store the AF4 seed anchor ' + txid);
    }

    async stop(){
        try {
            // Only the rows this seed wrote at its unused fixture blocks: on a seeded run the
            // hub key is a roster key whose real capability rows sit at other blocks.
            for(const block of this.seededBlocks){
                await indexerQuery(
                    "DELETE FROM capability_snapshots WHERE snapshot_block = ? AND signing_pubkey = ? " +
                    "AND capability = 'oracle_publish'", [block, this.identity.getPubkeyHex().toLowerCase()]
                );
            }
            if(this.weightSeed) this.weightSeed.restore();
            if(this.mvh){ await this.mvh.stop(); await this.mvh.dropDatabases(); }
            if(this.hubDb) await this.hubDb.stop();
            if(this.signerDir) fs.rmSync(this.signerDir, { recursive: true, force: true });
        } finally {
            for(const key of MANAGED_ENV){
                if(this.priorEnv[key] === undefined) delete process.env[key];
                else process.env[key] = this.priorEnv[key];
            }
        }
    }
}

// Publishes one pre-fold cycle and tears its hub down. Returns [{ version, txid }].
async function seedUnarmedAnchors(){
    const seed = new UnarmedAnchorSeed();
    try {
        await seed.start();
        return await seed.publishCycle();
    } finally {
        await seed.stop();
    }
}

module.exports = { seedUnarmedAnchors, seededVersions };
