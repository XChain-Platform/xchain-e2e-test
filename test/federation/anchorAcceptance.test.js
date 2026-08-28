/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 * E2E acceptance: ANCHOR on a LIVE DOGE regtest chain.
 *
 * The on-chain leg the L2 federation test can't cover: a real hub
 * (in-process, single validator via the XDEX_SEED_LOCAL_VALIDATOR seam)
 * checkpoints the REAL DOGE indexer state (getblockhashes RPC), publishes a
 * checkpoint anchor + a match archive as REAL DOGE transactions through the
 * encoder's P2SH two-tx pipeline, the regtest miner mines them, the decoder
 * parses them, and the indexer's ANCHOR handler verifies + stores them.
 *
 * This is acceptance test AT1 of anchor-bundle-per-network.md, driven: with
 * BTC/LTC/DOGE regtest checkpoints pending, one flush lands ONE ANCHOR v7 on
 * DOGE regtest with THREE sections, the indexer holds three anchor_actions rows
 * sharing one action_index at section_index 0..2 all `valid`, and every
 * state_checkpoints row carries the same anchor_txid. The DOGE section is the
 * REAL checkpoint the engine cut from the live indexer; BTC and LTC are
 * synthetic rows signed with the seeded validator's own key over the hub's own
 * XCHECKPOINT canonical (StateCheckpointEngine.canonicalCheckpoint), so all
 * three sections verify against the same mirrored oracle_publish set rather
 * than one section being real and two being 'invalid: SECTION n'.
 *
 * The CHECKPOINT leg has exactly one version now: v7. The per-chain wires
 * v0/v3/v4/v5 were deleted with the bundle (D2), and a degraded publisher
 * attestation falls back WITHIN v7 to ATTEST_SIG_COUNT 0 rather than to an
 * older version. The ARCHIVE leg is untouched and still picks v1/v6 from the
 * flag-days active at the resolved snapshot_block, so this suite still derives
 * that one from the hub's own frozen modules via
 * test/helpers/anchorVersionHelper.js.
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
 * capability snapshot rows are hand-mirrored into the indexer DB (the
 * mirror TRANSPORT (hub_db_sync WS/REST) is covered by its own unit + L2
 * tests; this run accepts the ON-CHAIN pipeline).
 *
 * SIGNER PATH IS PRODUCTION: broadcasts go through the hub's signer-loader
 * (HUB_SIGNER_MODULE) loading a staged copy of examples/doge-signer.example.js
 * (the exact module operators install in ~/hub-signer), which drives the sdk
 * two-phase P2SH pipeline (encoder createTx → signPsbt → broadcast →
 * spendP2sh → signRevealPsbt → broadcast). A walletSign-only or custom test
 * hook would skip the phase-2 reveal path, which is precisely where the
 * 2026-06-11 mainnet shakedown bug hid. The test only wraps the production
 * hook to mine + quiesce after each publish (regtest has no organic blocks,
 * and the tracker must see fresh UTXOs between the bundle and archive publishes).
 *
 * The follow-up recovery drill (wipe indexer DB -> reindex from chain ->
 * src/recovery.js -> byte-identical hash triples) is driven by the runner
 * after this suite passes -- see the acceptance report.
 *
 * Three gaps that make the pipeline above unrunnable on a realistic venue,
 * plus two reward-leg-only gaps, closed here with the repo's own seams
 * (never re-derived plumbing):
 *
 *   (a) The platform DB user (xchain_hub / the indexer user) lacks CREATE
 *       DATABASE, and MultiValidatorHub makes one DB per hub -> hub.start()
 *       dies ER_DBACCESS_DENIED_ERROR. Fixed via test/helpers/disposableHubDb.js
 *       with forceDocker:true (resolution path (1) would otherwise hand back
 *       the venue's authenticating-but-can't-CREATE credential).
 *   (b) On a DOGE-only venue the hub resolves the local indexer as its BTC
 *       indexer, sees a DOGE indexer, and every live oracle_publish/cross_chain
 *       resolution fails; _getActiveOraclePublishPubkeys has NO local-DB
 *       fallback (only _resolveCapabilitySet does), so publisher election and
 *       the fail-closed defer check both starve regardless of any row seeded
 *       into capability_snapshots. Fixed via test/helpers/seededWeightSnapshot.js,
 *       which monkeypatches hub.capabilitySnapshot.getWeightSnapshot /
 *       getActiveWeightSnapshot directly (the one seam both call sites share)
 *       and sets hub.network = 'regtest' so the WEIGHTED path is taken.
 *   (c) XCHAIN_CONFIRMATIONS_DOGE defaults to 60 (coins/DOGE.js), read into
 *       StateAnchorPublisher.dogeConfirmations ONCE at construction
 *       (coins.resolveConfirmations); unreachable on regtest inside one test's
 *       block budget. Set to a low value BEFORE `new MultiValidatorHub(...)`.
 *
 * Reward-leg-only (not asserted by this suite's own checks, but required for
 * the ATTESTED path -- without it the publisher's attestation round abstains and
 * the bundle lands with ATTEST_SIG_COUNT 0, which creates no reward row):
 *   - an oracle_publish row seeded into the HUB's OWN capability_snapshots
 *     (the prior version of this fixture seeded only cross_chain hub-side);
 *   - a NON-BLANK `source` on those rows (WI-1: the stake-weighted tally
 *     dedupes by source and fails closed on a blank one).
 * seedWeightSnapshot's monkeypatch already makes both capabilities resolve
 * correctly without touching the DB (it intercepts the method, not the
 * table), so this insert is a belt-and-suspenders mirror of the indexer-side
 * seed below, not the load-bearing fix -- see the code comment at the
 * insert site.
 *
 * Also: a same-snapshot-block re-run self-poisons. The INDEXER db is real and
 * persistent across runs (unlike the disposable hub db, torn down every run);
 * each run's fresh MultiValidatorHub validator pubkey lands a NEW row at the
 * SAME snapshot_block, so a second run's one live signer is only 50% of the
 * tallied stake and on-chain verify fails closed. SNAPSHOT_BLOCK is therefore
 * derived per-run (override via ANCHOR_ACCEPTANCE_SNAPSHOT_BLOCK for a
 * deliberate replay).
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const zlib   = require('zlib');
const path   = require('path');

const fs = require('fs');
const { encode: wifEncode } = require('wif');

const cryptoHelper      = require('../cryptoHelper');
const CryptoNetworks    = require('../../src/CryptoNetworks');
const { MultiValidatorHub, ValidatorIdentity, loadHubModule, resolveHubFile } = require('../helpers/multiValidatorHubHelper');
const anchorVersions    = require('../helpers/anchorVersionHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../helpers/seededWeightSnapshot');

// Gap (a): forced off the ambient venue credential (CREATE DATABASE denied)
// onto a disposable Docker MariaDB. Port/name derived from the pid so this
// suite doesn't collide with another session's own disposable container on
// the shared venue.
const HUB_DB_PORT = 13300 + (process.pid % 300);
const HUB_DB_NAME = 'xchain-anchor-acceptance-hubdb-' + process.pid;

// Gap: self-poisoning re-runs (see file header). Override for a deliberate
// replay against the same block; otherwise unique per run.
const SNAPSHOT_BLOCK = Number(process.env.ANCHOR_ACCEPTANCE_SNAPSHOT_BLOCK) || (200000 + (Date.now() % 700000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('ANCHOR live acceptance: DOGE regtest on-chain pipeline', function () {
    this.timeout(15 * 60 * 1000);

    let mvh = null, hub = null, identity = null;
    let hubDb = null;                  // gap (a): disposable Docker MariaDB handle
    let weightSeed = null;             // gap (b): seededWeightSnapshot restore()
    let publisherAddr = null;
    let signerDir = null;              // staged production signer (~/hub-signer analogue)
    let broadcasts = [];               // { payload, txid, phase1_txid }
    let matchId = crypto.createHash('sha256').update('anchor-acceptance-' + Date.now()).digest('hex');
    let SCE = null;                    // hub's StateCheckpointEngine, for the canonical
    let bundleSections = [];           // the three checkpoint rows the bundle carried
    let bundleTxid = null;             // AT4 reads the same bundle back through the RPC

    // Stage examples/doge-signer.example.js the way an operator installs it:
    // its own directory with its own node_modules (symlinked to the checkouts
    // the e2e host already has), loaded via HUB_SIGNER_MODULE through the
    // hub's REAL signer-loader boot path.
    function stageProductionSigner(addressInfo){
        const examplePath = resolveHubFile('examples/doge-signer.example.js');
        // os.tmpdir(), NOT __dirname: the e2e tree may live on a Parallels
        // share where symlink creation is unreliable; /tmp is always local.
        signerDir = path.join(require('os').tmpdir(), 'xchain-anchor-signer-' + process.pid);
        fs.rmSync(signerDir, { recursive: true, force: true });
        fs.mkdirSync(path.join(signerDir, 'node_modules'), { recursive: true });
        fs.copyFileSync(examplePath, path.join(signerDir, 'signer.js'));
        for (const dep of ['xchain-sdk', 'dotenv']) {
            let target;
            try { target = path.dirname(require.resolve(dep + '/package.json')); }
            catch (e) {
                target = path.resolve(__dirname, '../../../', dep);            // monorepo sibling checkout
                if (!fs.existsSync(target)) throw new Error('cannot resolve ' + dep + ' for the staged signer');
            }
            fs.symlinkSync(target, path.join(signerDir, 'node_modules', dep), 'dir');
        }

        // The signer's .env contract, via process env (dotenv never overrides
        // existing vars, and no .env file is written; the WIF stays in memory).
        const network = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK);
        process.env.DOGE_NETWORK     = COIN + '-' + NETWORK;
        process.env.DOGE_ADDRESS     = addressInfo.address;
        process.env.DOGE_WIF         = wifEncode(network.wif, Buffer.from(addressInfo.privateKey), true);
        process.env.DOGE_ENCODER_URL = 'http://' + (process.env.ENCODER_URL || 'localhost') + ':' +
                                       (process.env.ENCODER_API_PORT || '3023');
        process.env.HUB_SIGNER_MODULE = path.join(signerDir, 'signer.js');

        const { loadSignerHooks } = loadHubModule('src/lib/signer-loader.js');
        const hooks = loadSignerHooks(process.env);
        assert.ok(hooks && hooks.broadcastFn, 'signer-loader wired the example signer\'s broadcast hook');
        return hooks;
    }

    async function indexerQuery(sql, params){
        let conn = await indexerDatabase.getConnection();
        try { return await conn.query(sql, params); }
        finally { await conn.release(); }
    }

    // A root-bearing checkpoint row for a chain this DOGE-only venue has no engine
    // for, signed by the seeded validator over the hub's OWN canonical
    // (StateCheckpointEngine.canonicalCheckpoint, the exact bytes the indexer's
    // ANCHOR verifier and the SDK rebuild). Signing it here is what makes AT1's
    // "all three sections valid" a real verdict: an unsigned filler row would
    // invalidate the WHOLE bundle (D15) and the run would prove nothing.
    //
    // Roots are REQUIRED, not decorative: the publisher SKIPS a rootless row with a
    // log line rather than emitting a rootless section (D8), so a filler without
    // them would be silently absent and the bundle would come out short.
    function signedSyntheticCheckpoint(chain, seq, snapshotBlock){
        let row = {
            chain, network: 'regtest', block_index: 100000 + seq,
            block_hash:    crypto.randomBytes(32).toString('hex'),
            ledger_hash:   crypto.randomBytes(32).toString('hex'),
            actions_hash:  crypto.randomBytes(32).toString('hex'),
            contract_hash: crypto.randomBytes(32).toString('hex'),
            checkpoint_seq: seq, snapshot_block: snapshotBlock,
            state_root:           crypto.randomBytes(32).toString('hex'),
            state_root_version:   1,
            block_merkle_root:    crypto.randomBytes(32).toString('hex'),
            block_merkle_version: 1
        };
        row.validator_signatures = JSON.stringify([{
            pubkey: identity.getPubkeyHex().toLowerCase(),
            sig:    identity.sign(SCE.canonicalCheckpoint(row))
        }]);
        return row;
    }

    async function insertCheckpoint(row){
        await hub.db.doQuery(
            'INSERT IGNORE INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, ' +
            'actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures, ' +
            'state_root, state_root_version, block_merkle_root, block_merkle_version) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [row.chain, row.network, row.block_index, row.block_hash, row.ledger_hash,
             row.actions_hash, row.contract_hash, row.checkpoint_seq, row.snapshot_block,
             row.validator_signatures, row.state_root, row.state_root_version,
             row.block_merkle_root, row.block_merkle_version]);
    }

    before(async function () {
        // Deterministic regtest seams: set BEFORE any hub engine is constructed.
        process.env.XDEX_SEED_LOCAL_VALIDATOR = '1';
        process.env.XDEX_SNAPSHOT_BLOCK       = String(SNAPSHOT_BLOCK);
        process.env.CHECKPOINT_CHAINS         = 'DOGE';
        process.env.CHECKPOINT_CONFIRMATIONS  = '2';
        process.env.CHECKPOINT_POLL_MS        = '600000';      // manual ticks only
        process.env.ANCHOR_INTERVAL_MS        = '600000000';   // manual flush only
        if(!process.env.DOGE_INDEXER_URL)
            process.env.DOGE_INDEXER_URL = 'http://localhost:' + (process.env.INDEXER_API_PORT || '3124');
        // Gap (c): coins/DOGE.js's confirmations:60 (StateAnchorPublisher.dogeConfirmations,
        // frozen at hub construction below) is unreachable inside this suite's block
        // budget. Must be set BEFORE `new MultiValidatorHub` / mvh.start(), which is
        // when coins.resolveConfirmations reads it.
        process.env.XCHAIN_CONFIRMATIONS_DOGE = '1';

        // Gap (a): the ambient venue credential (xchain_hub / the indexer DB user)
        // authenticates but lacks CREATE DATABASE, which MultiValidatorHub needs (one
        // DB per hub). forceDocker:true is required -- without it, resolution path (1)
        // in disposableHubDb hands back that same venue credential (it's already in
        // env on a live host) instead of provisioning a throwaway root container.
        hubDb = await startDisposableHubDb({ forceDocker: true, port: HUB_DB_PORT, name: HUB_DB_NAME });
        if (!hubDb) { console.log('Skipping ANCHOR live acceptance: no Docker available for the disposable hub DB'); this.skip(); }

        mvh = new MultiValidatorHub({
            count: 1, basePort: 34100,
            startCrossChain: true, startAttestation: false,
            dbNamePrefix: 'XChain_DOGE_Regtest_ANCHOR_' + process.pid + '_'
        });
        await mvh.start();
        hub      = mvh.hubs[0];
        identity = new ValidatorIdentity(mvh.identities[0].privkeyHex);
        // The hub's OWN canonical builder, so the synthetic BTC/LTC sections are
        // signed over byte-identical bytes to what the indexer rebuilds. Never
        // re-implemented in the test: a drifting copy would fail closed as
        // 'invalid: SECTION n' and read as a publisher bug.
        SCE = loadHubModule('src/StateCheckpointEngine.js');

        // Gap (b): the local indexer is DOGE, not BTC, so hub.capabilitySnapshot's
        // live getSnapshot/getWeightSnapshot calls fail (wrong-chain indexer), and
        // _getActiveOraclePublishPubkeys has NO local-table fallback (unlike
        // _resolveCapabilitySet) -- it just returns [] and every anchor gets deferred
        // "empty oracle_publish set (fail closed)". seedWeightSnapshot patches
        // getWeightSnapshot/getActiveWeightSnapshot directly (the one seam both
        // election and signing-set resolution share) and sets hub.network='regtest'
        // so the WEIGHTED path is taken. Single-hub venue -> this hub's own identity
        // is the sole (100%-stake) source, matching `identity` used below to sign.
        weightSeed = seedWeightSnapshot(mvh, { blockIndex: SNAPSHOT_BLOCK, network: 'regtest' });
        // Defensive mirror of the proven StateCheckpointEngine gotcha (see
        // multiHubStateAnchorWeighted.integration.test.js): every consensus engine,
        // StateAnchorPublisher included, caches `this.network = hub.network` ONCE AT
        // CONSTRUCTION (StateAnchorPublisher.js:170), before seedWeightSnapshot ever
        // runs. HUB_NETWORK is threaded through MultiValidatorHub's p2pConfig
        // (defaults to regtest) so this is likely already correct by construction,
        // but setting it again here costs nothing and removes the dependency on that
        // threading being intact.
        hub.stateAnchorPublisher.network = 'regtest';

        // Fund the publisher address; every ANCHOR broadcast goes through the
        // REAL client pipeline (encoder createTx -> sign -> broadcast -> P2SH
        // reveal tx), identical to how a production operator publishes.
        publisherAddr = await cryptoHelper.getNewFundedAddress(
            'anchor-publisher', COIN, NETWORK, null, 'legacy', 0, 2.0
        );
        await regtestMinerConnector.generateBlocks(2);
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });

        // PRODUCTION signer path: signer-loader -> staged doge-signer.example.js
        // -> sdk two-phase P2SH pipeline. The wrapper only adds regtest
        // block-production so the tracker sees fresh UTXOs before the next
        // publish in the same flush.
        const hooks = stageProductionSigner(publisherAddr);
        hub.stateAnchorPublisher.setBroadcastHook(async (payload) => {
            const result = await hooks.broadcastFn(payload);
            broadcasts.push({ payload, txid: result.txid, phase1_txid: result.phase1_txid });
            await regtestMinerConnector.generateBlocks(1);
            await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
            return result;
        });

        // Rerunnability on a dirty regtest chain: the indexer's replay guards
        // reject seqs at-or-below the on-chain max, and this driver's hub DB is
        // fresh (seqs restart at 0). Seed the hub's counters past whatever a
        // prior run already anchored.
        // Version lists cover the WHOLE family on each leg (checkpoint 0/3/4/5,
        // archive 1/6): a post-flag-day venue's prior run anchored v5/v6 rows,
        // and a (0,1)-only scan would miss them and restart the seqs low enough
        // for the indexer's replay guard to reject this run's anchors.
        let prior = await indexerQuery(
            `SELECT MAX(checkpoint_seq) AS max_cp,
                    (SELECT MAX(match_batch_seq) FROM anchor_actions WHERE version IN (1, 6)) AS max_batch
             FROM anchor_actions WHERE version IN (0, 1, 3, 4, 5, 6)`);
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
        if (weightSeed) weightSeed.restore();
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (hubDb) await hubDb.stop();
        if (signerDir) fs.rmSync(signerDir, { recursive: true, force: true });
        delete process.env.DOGE_WIF;
        delete process.env.HUB_SIGNER_MODULE;
    });

    it('AT1: checkpoints REAL indexer state and lands ONE quorum-signed v7 bundle with three sections on the DOGE chain', async function () {
        await hub.stateCheckpoints._tick();
        let cps = await hub.db.doQuery(
            "SELECT * FROM state_checkpoints WHERE chain = 'DOGE' AND network = 'regtest' ORDER BY checkpoint_seq DESC LIMIT 1");
        assert.strictEqual(cps.length, 1, 'hub holds a DOGE checkpoint after the tick');
        let cp = cps[0];
        assert.match(String(cp.ledger_hash), /^[0-9a-f]{64}$/);
        // A v7 section is root-bearing by construction (D8). Regtest arms
        // CHECKPOINT_COMMITMENT at genesis, so a real engine-cut row without roots
        // means the SPV leg is broken, not that the anchor should fall back.
        assert.ok(anchorVersions.checkpointCarriesRoots(cp),
            'the engine-cut DOGE checkpoint carries its SPV roots; a rootless row is SKIPPED, never anchored rootless');
        console.log('    checkpoint: DOGE@' + cp.block_index + ' ledger ' + String(cp.ledger_hash).slice(0, 16) + '... snapshot_block ' + cp.snapshot_block);

        // The REAL snapshot block resolved by the hub at tick time; everything
        // downstream (capability mirror rows, the synthetic match) keys on it.
        let snapBlock = Number(cp.snapshot_block);

        // Hand-mirror the capability snapshot into the INDEXER DB (what
        // hub_db_sync would deliver in a hub-connected deployment) so the
        // ANCHOR handler verifies signatures as 'valid' rather than 'unverified'.
        for (let cap of ['oracle_publish', 'cross_chain']) {
            // WI-1: the indexer verify is stake-weighted on regtest (activates at
            // genesis) and tallies by DISTINCT source; a blank source FAILS CLOSED.
            // Seed a non-blank source (the validator's own key = its staking source)
            // so the single signer is 100% of stake (3·S > 2·S -> valid).
            await indexerQuery(
                'INSERT INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?) ' +
                'ON DUPLICATE KEY UPDATE amount = VALUES(amount), source = VALUES(source)',
                [snapBlock, cap, identity.getPubkeyHex().toLowerCase(), '1', identity.getPubkeyHex().toLowerCase()]);
        }
        let seeded = await indexerQuery(
            'SELECT capability FROM capability_snapshots WHERE snapshot_block = ?', [snapBlock]);
        console.log('    seeded capability rows @ ' + snapBlock + ': ' + JSON.stringify(seeded.map(r => r.capability)));
        assert.strictEqual(seeded.length, 2, 'capability snapshot rows readable at snapshot block ' + snapBlock);

        // AT1 needs BTC/LTC/DOGE checkpoints PENDING at one snapshot block. This
        // venue runs a DOGE indexer only, so the other two rides are synthetic rows
        // at the SAME snapshot_block, signed by the same seeded validator over the
        // hub's own canonical, hence verifiable by the same mirrored oracle_publish
        // set. Seqs clear the indexer's per-chain replay guard on a dirty chain.
        for (let chain of ['BTC', 'LTC']) {
            let prior = await indexerQuery(
                'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS s FROM anchor_actions WHERE chain = ? AND network = ?',
                [chain, 'regtest']);
            await insertCheckpoint(signedSyntheticCheckpoint(chain, Number(prior[0].s), snapBlock));
        }

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

        // Persist cross_chain AND oracle_publish into the HUB's own local
        // capability_snapshots: what CrossChainDexConsensus._broadcastPropose
        // persists for cross_chain when a real match finalizes (the synthetic
        // match here bypassed the engine), extended to oracle_publish too.
        // Without an oracle_publish row here, the publisher-attestation round has
        // no quorum to reach and the bundle lands with ATTEST_SIG_COUNT 0, which
        // carries no attestation and creates no reward row. A blank `source` would also fail the WI-1 stake-weighted
        // tally closed, so it's set to the validator's own key (its staking
        // source), matching the indexer-side seed above.
        //
        // NOTE: this is a belt-and-suspenders mirror, not the load-bearing fix --
        // seedWeightSnapshot's monkeypatch on hub.capabilitySnapshot already makes
        // both capabilities resolve correctly straight through the live method
        // (getWeightSnapshot), never touching this table. It's kept for any path
        // that reads capability_snapshots directly (recovery) rather than through
        // _resolveCapabilitySet/_getActiveOraclePublishPubkeys.
        for (let cap of ['cross_chain', 'oracle_publish']) {
            await hub.db.doQuery(
                'INSERT IGNORE INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?)',
                [snapBlock, cap, identity.getPubkeyHex().toLowerCase(), '1', identity.getPubkeyHex().toLowerCase()]);
        }

        // The checkpoint leg is v7 and nothing else (D2). Only the ARCHIVE leg still
        // has a version to derive from the flag-days at the resolved snapshot_block.
        let cpExpect  = anchorVersions.expectedCheckpointAnchor(cp);
        let arcExpect = anchorVersions.expectedArchiveAnchor(cp);
        console.log('    expecting ' + cpExpect.describe + ' + ' + arcExpect.describe);

        let summary = await hub.stateAnchorPublisher.flush();
        assert.ok(broadcasts.length >= 2,
            'expected a bundle + archive broadcast, got ' + broadcasts.length);

        // ONE v7 for the network, carrying all three chains. Three separate
        // checkpoint transactions is exactly the shape the bundle replaced.
        let bundleWires = anchorVersions.bundleBroadcasts(broadcasts);
        assert.strictEqual(bundleWires.length, 1,
            'exactly one ANCHOR v7 bundle, got ' + bundleWires.length + '; saw versions ' +
            JSON.stringify(broadcasts.map(b => anchorVersions.anchorPayloadVersion(b.payload))));
        let v7 = bundleWires[0];
        let v1 = anchorVersions.findAnchorBroadcast(broadcasts, arcExpect.accepted);
        assert.ok(v7.txid, 'the bundle published with a real txid');
        assert.ok(v1 && v1.txid, arcExpect.describe + ' published with a real txid; saw versions ' +
            JSON.stringify(broadcasts.map(b => anchorVersions.anchorPayloadVersion(b.payload))));

        assert.strictEqual(v7.bundle.section_count, 3, 'three sections: BTC, DOGE, LTC');
        assert.deepStrictEqual(v7.bundle.chains, ['BTC', 'DOGE', 'LTC'], 'sections ride CHAIN ascending (D5)');
        assert.strictEqual(v7.bundle.network, 'regtest', 'the wire NETWORK on regtest is the literal "regtest"');
        assert.strictEqual(v7.bundle.snapshot_block, snapBlock, 'header SNAPSHOT_BLOCK is the MAX over sections (D6)');
        for (let s of v7.bundle.sections)
            assert.ok(s.state_root && s.block_merkle_root, s.chain + ': the section carries its roots');

        // The two-phase property the walletSign-only gap used to hide: each
        // publish must produce a DISTINCT phase-1 funding tx and phase-2
        // reveal tx (the decodable one). A single-tx publish here means the
        // reveal leg silently vanished, which is exactly the production bug class.
        for (let b of [v7, v1]) {
            assert.ok(b.phase1_txid, 'publish went two-phase (phase-1 txid present)');
            assert.notStrictEqual(b.phase1_txid, b.txid, 'phase-2 reveal txid differs from phase-1');
        }
        // The flush summary (the anchorflush RPC surface) reports ONE entry per
        // SECTION, all naming the one bundle transaction.
        assert.strictEqual(summary.anchored.length, 3, 'flush summary names all three anchored sections');
        for (let a of summary.anchored)
            assert.strictEqual(a.txid, v7.txid, a.chain + ': every section names the one bundle txid');
        assert.strictEqual(summary.archive, 'published');
        let arcVersion = anchorVersions.anchorPayloadVersion(v1.payload);
        bundleTxid = v7.txid;
        console.log('    on-chain: bundle v7 [' + v7.bundle.chains.join(',') + '] ' + v7.txid +
                    ' (' + v7.bundle.attest_sig_count + ' attesting sig(s)) / archive v' + arcVersion +
                    ' ' + v1.txid + ' (phase-1: ' + v7.phase1_txid + ' / ' + v1.phase1_txid + ')');

        // The three checkpoint rows the bundle carried, for the AT4 read-back below.
        bundleSections = await hub.db.doQuery(
            'SELECT * FROM state_checkpoints WHERE network = ? AND snapshot_block = ? AND anchor_txid = ? ORDER BY chain ASC',
            ['regtest', snapBlock, v7.txid]);
        assert.strictEqual(bundleSections.length, 3,
            'every section row is stamped with the bundle txid on the publisher');

        // Confirm + let decoder/indexer catch up. A dirty chain may carry anchors
        // from prior runs, so match on content rather than position.
        await regtestMinerConnector.generateBlocks(3);
        let sections = [], r1 = null;
        for (let i = 0; i < 60 && (sections.length !== 3 || !r1); i++) {
            let rows = await indexerQuery(
                `SELECT a.*, s.status FROM anchor_actions a
                 LEFT JOIN index_statuses s ON s.id = a.status_id
                 ORDER BY a.action_index ASC, a.section_index ASC`);
            // Seeded off OUR DOGE section's ledger_hash, so a prior run's bundle on
            // this dirty chain cannot satisfy the assert.
            sections = anchorVersions.findBundleSectionRows(rows, cp.ledger_hash);
            r1 = anchorVersions.findAnchorRow(rows, [arcVersion], cp.ledger_hash);
            if (sections.length !== 3 || !r1) await sleep(2000);
        }
        assert.strictEqual(sections.length, 3, 'the indexer stored three section rows for our bundle');
        assert.ok(r1, 'archive v' + arcVersion + ' row for our archive present');

        // AT1's core evidence: ONE action_index, section_index 0..2, all valid.
        let actionIndex = String(sections[0].action_index);
        for (let s of sections)
            assert.strictEqual(String(s.action_index), actionIndex, 'all three sections share one action_index');
        assert.deepStrictEqual(sections.map(s => Number(s.section_index)), [0, 1, 2],
            'section_index runs 0..2 in wire order');
        for (let s of sections)
            assert.strictEqual(String(s.status), 'valid',
                s.chain + ' section verified against the mirrored oracle_publish set (got ' + s.status + ')');
        assert.deepStrictEqual(sections.map(s => String(s.chain)), ['BTC', 'DOGE', 'LTC']);
        // Every section row carries its OWN per-chain identity and the BUNDLE's
        // network (rebuilt from the header, §2.1), which is what keeps
        // idx_anchor_checkpoint and every per-chain reader working unchanged.
        for (let s of sections) {
            assert.strictEqual(String(s.network), 'regtest', s.chain + ': header NETWORK written onto the section row');
            assert.ok(s.state_root && s.block_merkle_root, s.chain + ': section row carries its roots');
            assert.ok(String(s.validator_signatures || '').length > 2, s.chain + ': section row carries its signatures');
        }

        // Checkpoint leg: the on-chain DOGE section equals what the hub signed over
        // the REAL indexer hashes (the full circle: indexer -> hub -> chain -> indexer).
        let doge = sections.find(s => String(s.chain) === 'DOGE');
        assert.strictEqual(Number(doge.block_index), Number(cp.block_index));
        assert.strictEqual(String(doge.ledger_hash), String(cp.ledger_hash));
        assert.strictEqual(String(doge.actions_hash), String(cp.actions_hash));
        assert.strictEqual(String(doge.contract_hash), String(cp.contract_hash));
        console.log('    indexed: action_index ' + actionIndex + ', sections ' +
                    sections.map(s => s.section_index + ':' + s.chain + '=' + s.status).join(' '));

        // Archive leg: decompresses to the synthetic match + both capability sets.
        assert.strictEqual(String(r1.status), 'valid',
            'archive v' + arcVersion + ' verified against the mirrored oracle_publish set');
        let archive = JSON.parse(zlib.gunzipSync(Buffer.from(String(r1.archive_b64), 'base64url')).toString('utf8'));
        assert.strictEqual(archive.matches.length, 1);
        assert.strictEqual(archive.matches[0].match_id, matchId);
        assert.ok(archive.capability_snapshots.some(s => s.capability === 'cross_chain'));
        assert.ok(archive.capability_snapshots.some(s => s.capability === 'oracle_publish'));
        console.log('    parsed: bundle v7 + archive v' + arcVersion +
                    ' valid, archive carries match ' + matchId.slice(0, 16) + '...');
    });

    // AT4 (recovery). state_checkpoints is hub-mirror-owned and written only by
    // StateCheckpointEngine; no code path rebuilds it from anchors. What a node
    // recovers by parsing the chain IS the anchor_actions section rows, and
    // `getanchoraction` is the RPC that serves them by (chain, network, block_index,
    // seq), the same lookup the hub's own _findExistingBundle makes per section and
    // the SPV bootstrap reads.
    //
    // The record under test is the CHAIN-DERIVED one: these rows were written by
    // the indexer parsing the transaction, with no hub DB involved in the read.
    // Running the parse on a FRESHLY WIPED indexer (the full "no hub DB" form) is a
    // venue operation, not something a suite may do to a shared regtest stack, so
    // point XC_ANCHOR_FRESH_INDEXER_URL at a from-genesis indexer to have this
    // assert both views instead of one.
    it('AT4: every section of the bundle is served by getanchoraction on (chain, network, block_index, seq)', async function () {
        assert.ok(bundleSections.length === 3 && bundleTxid,
            'AT1 must have run first (it produces the bundle this reads back)');

        let targets = [{ label: 'this venue', conn: indexerConnector }];
        if (process.env.XC_ANCHOR_FRESH_INDEXER_URL) {
            let XChainIndexerConnector = require('../../src/XChainIndexerConnector');
            let u = new URL(process.env.XC_ANCHOR_FRESH_INDEXER_URL);
            targets.push({ label: 'fresh full-parse indexer',
                           conn: new XChainIndexerConnector(u.hostname, u.port,
                                                            process.env.INDEXER_API_KEY || null) });
        } else {
            console.log('    (no XC_ANCHOR_FRESH_INDEXER_URL; asserting the chain-derived rows on this venue only)');
        }

        for (let t of targets) {
            for (let s of bundleSections) {
                let r = await t.conn.call('getanchoraction', {
                    chain: String(s.chain), network: String(s.network),
                    block_index: Number(s.block_index), checkpoint_seq: Number(s.checkpoint_seq)
                });
                assert.ok(r && r.exists, t.label + ' / ' + s.chain + ': getanchoraction finds the section');
                assert.strictEqual(Number(r.version), 7, t.label + ' / ' + s.chain + ': served as a v7 section');
                assert.strictEqual(String(r.status), 'valid', t.label + ' / ' + s.chain + ': section is valid');
                assert.strictEqual(String(r.txid).toLowerCase(), String(bundleTxid).toLowerCase(),
                    t.label + ' / ' + s.chain + ': every section resolves to the ONE bundle transaction');
                assert.strictEqual(String(r.ledger_hash), String(s.ledger_hash),
                    t.label + ' / ' + s.chain + ': the section carries its own per-chain roots and hashes');
                assert.strictEqual(String(r.state_root).toLowerCase(), String(s.state_root).toLowerCase(),
                    t.label + ' / ' + s.chain + ': state_root recovered from the chain');
            }
            console.log('    ' + t.label + ': all three sections served by (chain, network, block_index, seq) at txid ' + bundleTxid);
        }
    });
});
