/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * E2E acceptance — ANCHOR on a LIVE DOGE regtest chain.
 *
 * The on-chain leg the L2 federation test can't cover: a real hub
 * (in-process, single validator via the XDEX_SEED_LOCAL_VALIDATOR seam)
 * checkpoints the REAL DOGE indexer state (getblockhashes RPC), publishes
 * ANCHOR v0 + a v1 match archive as REAL DOGE transactions through the
 * encoder's P2SH two-tx pipeline, the regtest miner mines them, the decoder
 * parses them, and the indexer's ANCHOR handler verifies + stores them.
 *
 * Pre-requisites (driven by the operator/runner, NOT this file):
 *   - dogecoin-regtest stack up (node, utxo-tracker, encoder, decoder,
 *     indexer, regtest-miner) with the ANCHOR-aware decoder/indexer code;
 *   - env: COIN=dogecoin NETWORK=regtest HUB_URL/HUB_PORT (config discovery),
 *     HUB_DB_USER/HUB_DB_PASS + HUB_DB_HOST/HUB_DB_PORT (driver hub DB),
 *     DOGE_INDEXER_URL (the checkpoint engine's getblockhashes target),
 *     XDEX_SEED_LOCAL_VALIDATOR=1.
 *
 * The synthetic cross-chain match is signed by the seeded validator and the
 * capability snapshot rows are hand-mirrored into the indexer DB — the
 * mirror TRANSPORT (hub_db_sync WS/REST) is covered by its own unit + L2
 * tests; this run accepts the ON-CHAIN pipeline.
 *
 * The follow-up recovery drill (wipe indexer DB → reindex from chain →
 * src/recovery.js → byte-identical hash triples) is driven by the runner
 * after this suite passes — see the acceptance report.
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const zlib   = require('zlib');
const path   = require('path');

const cryptoHelper      = require('../cryptoHelper');
const transactionHelper = require('../transactionHelper');
const { MultiValidatorHub, ValidatorIdentity } = require('../helpers/multiValidatorHubHelper');

const SNAPSHOT_BLOCK = 100;            // deterministic regtest anchor (XDEX_SNAPSHOT_BLOCK)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('ANCHOR live acceptance — DOGE regtest on-chain pipeline', function () {
    this.timeout(15 * 60 * 1000);

    let mvh = null, hub = null, identity = null;
    let publisherAddr = null;
    let broadcasts = [];               // { payload, txid }
    let matchId = crypto.createHash('sha256').update('anchor-acceptance-' + Date.now()).digest('hex');

    async function indexerQuery(sql, params){
        let conn = await indexerDatabase.getConnection();
        try { return await conn.query(sql, params); }
        finally { await conn.release(); }
    }

    before(async function () {
        // Deterministic regtest seams — set BEFORE any hub engine is constructed.
        process.env.XDEX_SEED_LOCAL_VALIDATOR = '1';
        process.env.XDEX_SNAPSHOT_BLOCK       = String(SNAPSHOT_BLOCK);
        process.env.CHECKPOINT_CHAINS         = 'DOGE';
        process.env.CHECKPOINT_CONFIRMATIONS  = '2';
        process.env.CHECKPOINT_POLL_MS        = '600000';      // manual ticks only
        process.env.ANCHOR_INTERVAL_MS        = '600000000';   // manual flush only
        if(!process.env.DOGE_INDEXER_URL)
            process.env.DOGE_INDEXER_URL = 'http://localhost:' + (process.env.INDEXER_API_PORT || '3124');

        mvh = new MultiValidatorHub({
            count: 1, basePort: 34100,
            startCrossChain: true, startAttestation: false,
            dbNamePrefix: 'XChain_DOGE_Regtest_ANCHOR_' + process.pid + '_'
        });
        await mvh.start();
        hub      = mvh.hubs[0];
        identity = new ValidatorIdentity(mvh.identities[0].privkeyHex);

        // Fund the publisher address; every ANCHOR broadcast goes through the
        // REAL client pipeline (encoder createTx → sign → broadcast → P2SH
        // reveal tx) — identical to how a production operator publishes.
        publisherAddr = await cryptoHelper.getNewFundedAddress(
            'anchor-publisher', COIN, NETWORK, null, 'legacy', 0, 2.0
        );
        await regtestMinerConnector.generateBlocks(2);
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });

        hub.stateAnchorPublisher.setBroadcastHook(async (payload) => {
            const txid = await transactionHelper.createAndSendTransaction(publisherAddr, payload);
            broadcasts.push({ payload, txid });
            await regtestMinerConnector.generateBlocks(1);
            await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
            return { txid };
        });

        // Rerunnability on a dirty regtest chain: the indexer's replay guards
        // reject seqs at-or-below the on-chain max, and this driver's hub DB is
        // fresh (seqs restart at 0). Seed the hub's counters past whatever a
        // prior run already anchored.
        let prior = await indexerQuery(
            `SELECT MAX(checkpoint_seq) AS max_cp,
                    (SELECT MAX(match_batch_seq) FROM anchor_actions WHERE version = 1) AS max_batch
             FROM anchor_actions WHERE version IN (0, 1)`);
        let maxCp    = (prior.length && prior[0].max_cp    != null) ? Number(prior[0].max_cp)    : null;
        let maxBatch = (prior.length && prior[0].max_batch != null) ? Number(prior[0].max_batch) : null;
        if (maxCp !== null) {
            await hub.db.doQuery(
                `INSERT IGNORE INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash,
                    actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures, anchor_txid)
                 VALUES ('DOGE', 'regtest', 0, ?, ?, ?, ?, ?, ?, '[]', 'seq-baseline')`,
                ['0'.repeat(64), '0'.repeat(64), '0'.repeat(64), '0'.repeat(64), maxCp, SNAPSHOT_BLOCK]);
        }
        if (maxBatch !== null) {
            await hub.db.doQuery(
                `INSERT IGNORE INTO cross_chain_matches
                    (match_id, snapshot_block, network, a_chain, a_action_index, a_tick, a_amount, a_payout_addr,
                     b_chain, b_action_index, b_tick, b_amount, b_payout_addr, effective_time,
                     validator_signatures, status, batch_seq, archived_status)
                 VALUES ('seq-baseline', ?, 'regtest', 'DOGE', 0, 'X', '0', 'x', 'LTC', 0, 'X', '0', 'x', 0,
                         '[]', 'finalized', ?, 'finalized')`,
                [SNAPSHOT_BLOCK, maxBatch]);
        }
    });

    after(async function () {
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
    });

    it('checkpoints REAL indexer state and lands quorum-signed ANCHOR v0+v1 on the DOGE chain', async function () {
        // 1. Checkpoint round against the LIVE indexer's getblockhashes.
        await hub.stateCheckpoints._tick();
        let cps = await hub.db.doQuery(
            "SELECT * FROM state_checkpoints WHERE chain = 'DOGE' AND network = 'regtest' ORDER BY checkpoint_seq DESC LIMIT 1");
        assert.strictEqual(cps.length, 1, 'hub holds a DOGE checkpoint after the tick');
        let cp = cps[0];
        assert.match(String(cp.ledger_hash), /^[0-9a-f]{64}$/);
        console.log('    checkpoint: DOGE@' + cp.block_index + ' ledger ' + String(cp.ledger_hash).slice(0, 16) + '... snapshot_block ' + cp.snapshot_block);

        // The REAL snapshot block resolved by the hub at tick time — everything
        // downstream (capability mirror rows, the synthetic match) keys on it.
        let snapBlock = Number(cp.snapshot_block);

        // Hand-mirror the capability snapshot into the INDEXER DB (what
        // hub_db_sync would deliver in a hub-connected deployment) so the
        // ANCHOR handler verifies signatures as 'valid' rather than 'unverified'.
        for (let cap of ['oracle_publish', 'cross_chain']) {
            await indexerQuery(
                'INSERT IGNORE INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount) VALUES (?, ?, ?, ?)',
                [snapBlock, cap, identity.getPubkeyHex().toLowerCase(), '1']);
        }
        let seeded = await indexerQuery(
            'SELECT capability FROM capability_snapshots WHERE snapshot_block = ?', [snapBlock]);
        console.log('    seeded capability rows @ ' + snapBlock + ': ' + JSON.stringify(seeded.map(r => r.capability)));
        assert.strictEqual(seeded.length, 2, 'capability snapshot rows readable at snapshot block ' + snapBlock);

        // Synthetic finalized cross-chain match, signed by the seeded validator
        // (gives the v1 archive real content without a second chain).
        let m = {
            match_id: matchId, snapshot_block: snapBlock, network: 'regtest',
            a_chain: 'DOGE', a_action_index: 11, a_kind: 'swap', a_tick: 'TOKA', a_amount: '1000',
            a_filled_before: '0', a_ownership: 0, a_payout_addr: 'acceptance_payout_a',
            b_chain: 'LTC', b_action_index: 22, b_kind: 'swap', b_tick: 'TOKB', b_amount: '2000',
            b_filled_before: '0', b_ownership: 0, b_payout_addr: 'acceptance_payout_b',
            effective_time: Math.floor(Date.now() / 1000)
        };
        let canonical = hub.crossChainDex._canonicalMatch(m);
        let sigs = JSON.stringify([{ pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical) }]);
        await hub.db.doQuery(
            `INSERT INTO cross_chain_matches
                (match_id, snapshot_block, network, a_chain, a_action_index, a_kind, a_tick, a_amount,
                 a_filled_before, a_ownership, a_payout_addr, b_chain, b_action_index, b_kind, b_tick,
                 b_amount, b_filled_before, b_ownership, b_payout_addr, effective_time,
                 validator_signatures, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'finalized')`,
            [m.match_id, m.snapshot_block, m.network, m.a_chain, m.a_action_index, m.a_kind, m.a_tick,
             m.a_amount, m.a_filled_before, m.a_ownership, m.a_payout_addr, m.b_chain, m.b_action_index,
             m.b_kind, m.b_tick, m.b_amount, m.b_filled_before, m.b_ownership, m.b_payout_addr,
             m.effective_time, sigs]);

        // Persist the cross_chain set into the HUB's local capability_snapshots —
        // what CrossChainDexConsensus._broadcastPropose does when a real match
        // finalizes (the synthetic match bypassed the engine). The archive
        // builder resolves capability sets from here when no BTC indexer
        // resolution is available.
        await hub.db.doQuery(
            'INSERT IGNORE INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount) VALUES (?, ?, ?, ?)',
            [snapBlock, 'cross_chain', identity.getPubkeyHex().toLowerCase(), '1']);

        // 2. Flush → REAL on-chain publication (v0 checkpoint + v1 archive).
        await hub.stateAnchorPublisher.flush();
        assert.ok(broadcasts.length >= 2, 'expected v0 + v1 broadcasts, got ' + broadcasts.length);
        let v0 = broadcasts.find(b => b.payload.split('|')[1] === '0');
        let v1 = broadcasts.find(b => b.payload.split('|')[1] === '1');
        assert.ok(v0 && v0.txid, 'v0 published with a real txid');
        assert.ok(v1 && v1.txid, 'v1 published with a real txid');
        console.log('    on-chain: v0 ' + v0.txid + ' / v1 ' + v1.txid);

        // 3. Confirm + let decoder/indexer catch up, then assert OUR parsed rows
        // (a dirty chain may carry anchors from prior runs — match on content).
        await regtestMinerConnector.generateBlocks(3);
        let r0 = null, r1 = null;
        for (let i = 0; i < 60 && (!r0 || !r1); i++) {
            let rows = await indexerQuery(
                `SELECT a.*, s.status FROM anchor_actions a
                 LEFT JOIN index_statuses s ON s.id = a.status_id
                 ORDER BY a.action_index ASC`);
            // Both rows wrap OUR checkpoint (the flush anchors the latest one).
            r0 = rows.find(r => Number(r.version) === 0 && String(r.ledger_hash) === String(cp.ledger_hash));
            r1 = rows.find(r => Number(r.version) === 1 && String(r.ledger_hash) === String(cp.ledger_hash));
            if (!r0 || !r1) await sleep(2000);
        }
        assert.ok(r0, 'v0 row for our checkpoint present');
        assert.ok(r1, 'v1 row for our archive present');

        // v0: the on-chain checkpoint equals what the hub signed over the REAL
        // indexer hashes — the full circle (indexer → hub → chain → indexer).
        assert.strictEqual(String(r0.status), 'valid', 'v0 verified against the mirrored oracle_publish set');
        assert.strictEqual(String(r0.chain), 'DOGE');
        assert.strictEqual(Number(r0.block_index), Number(cp.block_index));
        assert.strictEqual(String(r0.ledger_hash), String(cp.ledger_hash));
        assert.strictEqual(String(r0.actions_hash), String(cp.actions_hash));
        assert.strictEqual(String(r0.contract_hash), String(cp.contract_hash));

        // v1: archive decompresses to the synthetic match + both capability sets.
        assert.strictEqual(String(r1.status), 'valid', 'v1 verified against the mirrored oracle_publish set');
        let archive = JSON.parse(zlib.gunzipSync(Buffer.from(String(r1.archive_b64), 'base64url')).toString('utf8'));
        assert.strictEqual(archive.matches.length, 1);
        assert.strictEqual(archive.matches[0].match_id, matchId);
        assert.ok(archive.capability_snapshots.some(s => s.capability === 'cross_chain'));
        assert.ok(archive.capability_snapshots.some(s => s.capability === 'oracle_publish'));
        console.log('    parsed: v0+v1 valid, archive carries match ' + matchId.slice(0, 16) + '...');
    });
});
