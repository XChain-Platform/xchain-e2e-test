'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

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
const { parseAnchorV0 } = require('../../helpers/anchorVersionHelper');
const { startDisposableHubDb } = require('../../helpers/disposableHubDb');
const { seedWeightSnapshot } = require('../../helpers/seededWeightSnapshot');
const { waitForMesh, waitUntil } = require('../../helpers/consensusWait');
const {
    reverseSections,
    reverseSectionPairs
} = require('../../helpers/flag_days/anchor_order_tamper');

const VALIDATOR_COUNT = 2;
const HUB_DB_PORT = 14100 + (process.pid % 300);
const HUB_DB_NAME = 'xchain-anchor-order-hubdb-' + process.pid;
const SNAPSHOT_BLOCK = Number(process.env.ANCHOR_ORDER_SNAPSHOT_BLOCK) ||
    (1600000 + (Date.now() % 300000));

describe('ANCHOR v0 bundle ordering on DOGE regtest', function () {
    this.timeout(20 * 60 * 1000);

    let hubDb = null;
    let mvh = null;
    let weightSeed = null;
    let identities = [];
    let signerDir = null;
    let signerHooks = null;
    let preparedPayload = null;

    async function indexerQuery(sql, params){
        const conn = await indexerDatabase.getConnection();
        try { return await conn.query(sql, params); }
        finally { await conn.release(); }
    }

    async function allHubs(sql, params){
        for(const hub of mvh.hubs) await hub.db.doQuery(sql, params);
    }

    function stageProductionSigner(addressInfo){
        const examplePath = resolveHubFile('examples/doge-signer.example.js');
        signerDir = path.join(require('os').tmpdir(), 'xchain-anchor-order-signer-' + process.pid);
        fs.rmSync(signerDir, { recursive: true, force: true });
        fs.mkdirSync(path.join(signerDir, 'node_modules'), { recursive: true });
        fs.copyFileSync(examplePath, path.join(signerDir, 'signer.js'));

        for(const dep of ['xchain-sdk', 'dotenv']){
            let target;
            try { target = path.dirname(require.resolve(dep + '/package.json')); }
            catch(e){
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
        assert.ok(hooks && hooks.broadcastFn, 'production signer exposes its broadcast hook');
        return hooks;
    }

    function signedCheckpoint(chain, seq, canonical){
        const row = {
            chain, network: 'regtest', block_index: 500000 + seq,
            block_hash: crypto.randomBytes(32).toString('hex'),
            ledger_hash: crypto.randomBytes(32).toString('hex'),
            actions_hash: crypto.randomBytes(32).toString('hex'),
            contract_hash: crypto.randomBytes(32).toString('hex'),
            checkpoint_seq: seq, snapshot_block: SNAPSHOT_BLOCK,
            state_root: crypto.randomBytes(32).toString('hex'),
            state_root_version: 1,
            block_merkle_root: crypto.randomBytes(32).toString('hex'),
            block_merkle_version: 1
        };
        row.validator_signatures = JSON.stringify(identities.map(identity => ({
            pubkey: identity.getPubkeyHex().toLowerCase(),
            sig: identity.sign(canonical.canonicalCheckpoint(row))
        })));
        return row;
    }

    async function nextCheckpointSeq(chain){
        const rows = await indexerQuery(
            'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS seq FROM anchor_actions ' +
            'WHERE chain = ? AND network = ?', [chain, 'regtest']);
        return Number(rows[0].seq);
    }

    async function insertCheckpoint(row){
        await allHubs(
            'INSERT IGNORE INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, ' +
            'actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures, ' +
            'state_root, state_root_version, block_merkle_root, block_merkle_version) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [row.chain, row.network, row.block_index, row.block_hash, row.ledger_hash,
             row.actions_hash, row.contract_hash, row.checkpoint_seq, row.snapshot_block,
             row.validator_signatures, row.state_root, row.state_root_version,
             row.block_merkle_root, row.block_merkle_version]);
    }

    async function seedCapabilities(pubkeys){
        for(const pubkey of pubkeys){
            await indexerQuery(
                'INSERT INTO capability_snapshots ' +
                '(snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?) ' +
                'ON DUPLICATE KEY UPDATE amount = VALUES(amount), source = VALUES(source)',
                [SNAPSHOT_BLOCK, 'oracle_publish', pubkey, '1', pubkey]);
            await allHubs(
                'INSERT IGNORE INTO capability_snapshots ' +
                '(snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?)',
                [SNAPSHOT_BLOCK, 'oracle_publish', pubkey, '1', pubkey]);
        }
    }

    async function bootFederation(){
        process.env.XDEX_SNAPSHOT_BLOCK = String(SNAPSHOT_BLOCK);
        process.env.CHECKPOINT_CHAINS = 'DOGE';
        process.env.CHECKPOINT_POLL_MS = '600000000';
        process.env.ANCHOR_INTERVAL_MS = '600000000';
        process.env.XCHAIN_CONFIRMATIONS_DOGE = '1';
        if(!process.env.DOGE_INDEXER_URL)
            process.env.DOGE_INDEXER_URL = 'http://localhost:' + (process.env.INDEXER_API_PORT || '3124');

        hubDb = await startDisposableHubDb({ forceDocker: true, port: HUB_DB_PORT, name: HUB_DB_NAME });
        assert.ok(hubDb, 'a disposable hub database is required for the live order rail');
        mvh = new MultiValidatorHub({
            count: VALIDATOR_COUNT,
            basePort: 34900 + ((process.pid % 100) * 3),
            startCrossChain: true,
            startAttestation: false,
            dbNamePrefix: 'XChain_DOGE_Regtest_ANCHOR_ORDER_' + process.pid + '_'
        });
        await mvh.start();
        identities = mvh.identities.map(id => new ValidatorIdentity(id.privkeyHex));
        weightSeed = seedWeightSnapshot(mvh, { blockIndex: SNAPSHOT_BLOCK, network: 'regtest' });
        for(const hub of mvh.hubs){
            hub.stateAnchorPublisher.network = 'regtest';
            hub.stateAnchorPublisher.roundTimeoutMs = 20000;
        }
        await waitForMesh(mvh, { timeoutMs: 60000, intervalMs: 250 });
        await seedCapabilities(mvh.getPubkeys().map(pubkey => pubkey.toLowerCase()));
    }

    async function prepareCanonicalBundle(){
        const canonical = loadHubModule('src/anchor/checkpoint_engine.js');
        for(const chain of ['BTC', 'DOGE', 'LTC'])
            await insertCheckpoint(signedCheckpoint(chain, await nextCheckpointSeq(chain), canonical));

        const captured = [];
        for(const hub of mvh.hubs){
            hub.stateAnchorPublisher.setBroadcastHook(async payload => {
                if(parseAnchorV0(payload)) captured.push(payload);
                return { txid: 'f'.repeat(64) };
            });
        }
        for(const hub of mvh.hubs) await hub.stateAnchorPublisher.flush();
        await waitUntil(() => ({ ok: captured.length > 0, saw: captured.length }), {
            timeoutMs: 30000, intervalMs: 100, what: 'the publisher to build a v0 bundle'
        });
        assert.strictEqual(captured.length, 1, 'one elected publisher builds the bundle');
        preparedPayload = captured[0];

        const parsed = parseAnchorV0(preparedPayload);
        assert.deepStrictEqual(parsed.chains, ['BTC', 'DOGE', 'LTC']);
        for(const section of parsed.sections){
            assert.strictEqual(section.sigs.length, VALIDATOR_COUNT, section.chain + ' carries two pairs');
            const keys = section.sigs.map(sig => sig.pubkey);
            assert.deepStrictEqual(keys, keys.slice().sort(), section.chain + ' pairs start sorted');
        }
    }

    async function fundProductionSigner(){
        const addressInfo = await cryptoHelper.getNewFundedAddress(
            'anchor-order-publisher', COIN, NETWORK, null, 'legacy', 0, 5.0
        );
        await regtestMinerConnector.generateBlocks(2);
        const status = await utxoTrackerConnector.quiesce({
            timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector
        });
        assert.ok(status && status.ready, 'UTXO tracker is ready after funding the publisher');
        signerHooks = stageProductionSigner(addressInfo);
    }

    async function rowsForTransaction(txid){
        return await indexerQuery(
            'SELECT aa.section_index, s.status FROM anchor_actions aa ' +
            'JOIN actions a ON a.action_index = aa.action_index ' +
            'JOIN transactions t ON t.tx_index = a.tx_index ' +
            'JOIN index_transactions it ON it.id = t.tx_hash_id ' +
            'LEFT JOIN index_statuses s ON s.id = aa.status_id ' +
            'WHERE it.hash = ? ORDER BY aa.section_index ASC', [txid]);
    }

    async function publishPrepared(payload){
        const result = await signerHooks.broadcastFn(payload);
        assert.ok(result.txid, 'the reveal transaction has a txid');
        assert.ok(result.phase1_txid, 'the P2SH funding transaction has a txid');
        assert.notStrictEqual(result.txid, result.phase1_txid, 'funding and reveal txids differ');
        await regtestMinerConnector.generateBlocks(3);
        const status = await utxoTrackerConnector.quiesce({
            timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector
        });
        assert.ok(status && status.ready, 'UTXO tracker is ready after publishing the bundle');

        let rows = [];
        await waitUntil(async () => {
            rows = await rowsForTransaction(result.txid);
            return { ok: rows.length > 0, saw: rows.length };
        }, { timeoutMs: 120000, intervalMs: 1000, what: 'the DOGE indexer to store ' + result.txid });
        return rows;
    }

    function assertVerdict(rows, expected, label){
        assert.ok(rows.length > 0, label + ' writes at least one anchor_actions row');
        for(const row of rows) assert.match(String(row.status), expected, label + ' status');
    }

    before(async function () {
        await bootFederation();
        await prepareCanonicalBundle();
        await fundProductionSigner();
    });

    after(async function () {
        if(weightSeed) weightSeed.restore();
        if(mvh){ await mvh.stop(); await mvh.dropDatabases(); }
        if(hubDb) await hubDb.stop();
        if(signerDir) fs.rmSync(signerDir, { recursive: true, force: true });
        delete process.env.DOGE_WIF;
        delete process.env.HUB_SIGNER_MODULE;
    });

    it('accepts the publisher-sorted multi-section bundle as the control', async function () {
        const rows = await publishPrepared(preparedPayload);
        assert.strictEqual(rows.length, 3, 'the control writes one row per section');
        assertVerdict(rows, /^valid$/, 'sorted control');
    });

    it('rejects reversed sections with the chain-order reason', async function () {
        const rows = await publishPrepared(reverseSections(preparedPayload));
        assertVerdict(rows, /^invalid: SECTION \d+ CHAIN \(order\)$/, 'reversed sections');
    });

    it('rejects reversed PUBKEY and signature pairs with the pubkey-order reason', async function () {
        const rows = await publishPrepared(reverseSectionPairs(preparedPayload, 1));
        assertVerdict(rows, /^invalid: SECTION \d+ SIGS \(order\)$/, 'reversed section pairs');
    });
});
