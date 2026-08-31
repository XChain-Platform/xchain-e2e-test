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
 * E2E: ANCHOR v0 BUNDLE election on a LIVE DOGE regtest chain.
 *
 * The multi-validator paths the single-validator mainnet deployment never
 * exercises: four hubs over REAL P2P (Ed25519-verified gossip, per-hub
 * MariaDB), each with its OWN funded regtest DOGE wallet, electing ONE
 * publisher per NETWORK per cycle and publishing REAL two-phase P2SH
 * transactions.
 *
 * What changed with the bundle (anchor-bundle-per-network.md): the anchor rail
 * used to elect PER CHECKPOINT ROW, so three pending chains meant three
 * elections, three transactions, three attestation rounds and three
 * `anchor_<CHAIN>` rewards, split across whichever validators won each key.
 * Now every chain's newest un-anchored checkpoint rides ONE ANCHOR v0 as a
 * section, under ONE election keyed `XANCV7|NETWORK|SNAPSHOT_BLOCK` (the
 * internal round-id tag did not move with the wire's version byte, D3), with
 * ONE `anchor_bundle` reward. The cardinality IS the property under test, so
 * every assert here counts bundles and sections rather than rows.
 *
 * Verified:
 *
 *   1. AT1 (federation form): one flush across four hubs lands exactly ONE v0
 *      carrying all three chains as sections, chain-ascending, published by the
 *      bundle key's rank-0 validator and paid from that validator's own wallet;
 *      exactly one `anchor_bundle` reward at round_reference = SNAPSHOT_BLOCK;
 *      XANC_BUNDLE_DONE back-fills the SAME txid onto every section row on
 *      every hub; a second flush publishes nothing.
 *   2. AT3 (missing chain): a chain whose newest eligible checkpoint is already
 *      anchored is simply ABSENT from the next bundle and never delays it (D4:
 *      a short bundle is the NORMAL daily case, not an anomaly), and it rejoins
 *      at its newer seq once it cuts one.
 *   3. AT5 (failover race): ranks above 0 stay locked inside the tolerance
 *      window; rank 1 takes over after it elapses; a returning rank 0 that
 *      MISSED the announcement adopts the mined bundle through per-section
 *      `getanchoraction` (_findExistingBundle) instead of spending a second
 *      time, and both hubs rebuild byte-identical bundle payloads (D5).
 *   4. Archive round (unchanged leg): the per-election-block leader collects
 *      2f+1 co-signatures, publishes ANCHOR v1 (the tail always appended now,
 *      D4), and XANC_FINALIZED back-fills every hub, with the `anchor_archive`
 *      reward on the leader.
 *
 * The oracle_publish capability set is stubbed (identical 4-validator snapshot
 * on every hub): resolving REAL on-chain BTC stakes into snapshots is
 * CapabilitySnapshot's own concern, covered by its units and the Tier-2
 * federation proof. Everything downstream of the set (election, gossip,
 * signing, broadcast, DB state) is live.
 *
 * Pre-requisites: same dogecoin-regtest stack + env as
 * anchorAcceptance.test.js (node, utxo-tracker, encoder, decoder,
 * indexer, regtest-miner; HUB_DB_* for the driver hub DBs).
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { encode: wifEncode } = require('wif');

const cryptoHelper   = require('../cryptoHelper');
const CryptoNetworks = require('../../src/CryptoNetworks');
const { makeSdk }    = require('../sdk/sdkHelper');
const { MultiValidatorHub, ValidatorIdentity, loadHubModule } = require('../helpers/multiValidatorHubHelper');
const anchorVersions = require('../helpers/anchorVersionHelper');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = 4;

describe('ANCHOR bundle live: multi-validator per-NETWORK publisher (DOGE regtest)', function () {
    this.timeout(20 * 60 * 1000);

    let mvh = null, sdk = null, SAP = null;
    let wallets   = [];   // funded addressInfo per hub, hub order
    let pubkeys   = [];   // lowercase signing pubkeys, hub order
    let published = [];   // { hub, payload, txid, phase1_txid, from }
    let rewards   = [];   // { hub, type, round, pubkey }
    let cpRows    = [];   // synthetic checkpoints of the FIRST bundle

    // The bundle election key (StateAnchorPublisher._bundleElectionKey): ONE per
    // network per cycle, replacing the per-row XANCV0 key. The rank ladder is
    // otherwise unchanged, so the same hashOrder answers it.
    function bundleKey(network, snapshotBlock){
        return 'XANCV7|' + network + '|' + String(snapshotBlock);
    }
    function rankOrder(network, snapshotBlock){        // hub indices by election rank
        return SAP.hashOrder(bundleKey(network, snapshotBlock), pubkeys).map(pk => pubkeys.indexOf(pk));
    }

    async function indexerQuery(sql, params){
        let conn = await indexerDatabase.getConnection();
        try { return await conn.query(sql, params); }
        finally { await conn.release(); }
    }

    async function allHubs(sql, params){
        for (const hub of mvh.hubs) await hub.db.doQuery(sql, params);
    }

    // Poll until the XANC_BUNDLE_DONE back-fill has landed: every named hub's copy
    // of EVERY section row carries anchor_txid. Waiting on the back-fill itself
    // rather than a fixed settle costs time on a slow gossip round instead of a
    // false failure.
    async function waitForAnchorBackfill(rows, hubs, timeMax = 30000){
        const deadline = Date.now() + timeMax;
        while (Date.now() < deadline) {
            let missing = false;
            for (const row of rows) {
                for (const hub of hubs) {
                    const r = await hub.db.doQuery(
                        'SELECT anchor_txid FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ?',
                        [row.chain, row.network, row.block_index]);
                    if (!(r.length === 1 && r[0].anchor_txid)) { missing = true; break; }
                }
                if (missing) break;
            }
            if (!missing) return true;
            await sleep(500);
        }
        return false;
    }

    // Poll until the DOGE indexer has parsed and STORED every section of a bundle,
    // which is what _findExistingBundle's per-section getanchoraction reads. AT5's
    // adopt leg is only meaningful once this is true, and a fixed sleep here is the
    // difference between proving adoption and proving a race.
    async function waitForBundleIndexed(rows, timeMax = 120000){
        const deadline = Date.now() + timeMax;
        while (Date.now() < deadline) {
            let found = 0;
            for (const row of rows) {
                let r = await indexerQuery(
                    'SELECT action_index FROM anchor_actions WHERE version = 0 AND chain = ? AND network = ? ' +
                    'AND block_index = ? AND checkpoint_seq = ?',
                    [row.chain, row.network, row.block_index, row.checkpoint_seq]);
                if (r.length) found++;
            }
            if (found === rows.length) return true;
            await regtestMinerConnector.generateBlocks(1);
            await sleep(2000);
        }
        return false;
    }

    // Poll until XANC_FINALIZED has back-filled the archive batch metadata on every
    // named hub, the observable end of a SIGN round plus publish plus finalize.
    async function waitForArchiveFinalized(matchId, hubs, timeMax = 60000){
        const deadline = Date.now() + timeMax;
        while (Date.now() < deadline) {
            let missing = false;
            for (const hub of hubs) {
                const r = await hub.db.doQuery(
                    'SELECT batch_seq, archived_status FROM cross_chain_matches WHERE match_id = ?', [matchId]);
                if (!(r.length === 1 && r[0].batch_seq != null
                      && String(r[0].archived_status) === 'finalized')) { missing = true; break; }
            }
            if (!missing) return true;
            await sleep(500);
        }
        return false;
    }

    // The election clock is the indexer's committed tip; after mining, wait
    // for the decoder/indexer to catch up so failover-window math is exact.
    async function waitForTip(minBlock){
        for (let i = 0; i < 60; i++) {
            let b = await mvh.hubs[0]._resolveBtcLatestBlock();
            if (Number.isFinite(b) && b >= minBlock) return b;
            await sleep(1000);
        }
        throw new Error('indexer tip never reached ' + minBlock);
    }

    async function insertCheckpointEverywhere(row){
        await allHubs(
            'INSERT IGNORE INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, ' +
            'actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures, ' +
            'state_root, state_root_version, block_merkle_root, block_merkle_version) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [row.chain, row.network, row.block_index, row.block_hash, row.ledger_hash,
             row.actions_hash, row.contract_hash, row.checkpoint_seq, row.snapshot_block, row.validator_signatures,
             row.state_root, row.state_root_version, row.block_merkle_root, row.block_merkle_version]);
    }

    // A v0 section is ROOT-BEARING BY CONSTRUCTION (D8): the publisher SKIPS a
    // checkpoint row with null roots with a log line rather than emitting a
    // rootless wire, so a rootless synthetic row would be silently absent from
    // every bundle and every cardinality assert below would read as a bug in the
    // publisher. Every synthetic row therefore carries all four root fields.
    function syntheticCheckpoint(chain, seq, snapshotBlock){
        return {
            chain, network: 'regtest', block_index: 100000 + seq,
            block_hash:    crypto.randomBytes(32).toString('hex'),
            ledger_hash:   crypto.randomBytes(32).toString('hex'),
            actions_hash:  crypto.randomBytes(32).toString('hex'),
            contract_hash: crypto.randomBytes(32).toString('hex'),
            checkpoint_seq: seq, snapshot_block: snapshotBlock, validator_signatures: '[]',
            state_root:        crypto.randomBytes(32).toString('hex'),
            state_root_version: 1,
            block_merkle_root:  crypto.randomBytes(32).toString('hex'),
            block_merkle_version: 1
        };
    }

    // Seqs must clear the indexer's per-chain replay guard (dirty regtest
    // chains carry anchors from prior runs). v0 section rows carry their own
    // per-chain checkpoint_seq, so this reads exactly as it did per row.
    async function nextSeq(chain){
        let r = await indexerQuery(
            'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS s FROM anchor_actions WHERE chain = ? AND network = ?',
            [chain, 'regtest']);
        return Number(r[0].s);
    }

    // Every v0 bundle this run put on the wire, parsed. The archive leg (v1)
    // and any earlier run's wires are filtered out by the parser.
    function bundles(){
        return anchorVersions.bundleBroadcasts(published);
    }

    before(async function () {
        // Full-set capability stubs below; make sure the local-seed seam from
        // other suites/processes can't shadow them.
        delete process.env.XDEX_SEED_LOCAL_VALIDATOR;
        process.env.ANCHOR_INTERVAL_MS   = '600000000';            // manual flush only
        process.env.CHECKPOINT_POLL_MS   = '600000000';            // no engine ticks
        process.env.CHECKPOINT_CHAINS    = 'DOGE';
        process.env.ANCHOR_ELECTION_TOLERANCE_BLOCKS = '100000';   // phase 1: only rank 0 unlocks

        SAP = loadHubModule('src/StateAnchorPublisher.js');
        sdk = makeSdk();

        mvh = new MultiValidatorHub({
            count: N, basePort: 34300,
            startCrossChain: true, startAttestation: false,
            dbNamePrefix: 'XChain_DOGE_Regtest_ELECT_' + process.pid + '_'
        });
        await mvh.start();
        pubkeys = mvh.getPubkeys().map(p => p.toLowerCase());

        // Identical deterministic oracle_publish/cross_chain set on every hub.
        const validators = pubkeys.map(pk => ({ pubkey: pk, amount: '1' }));
        for (const hub of mvh.hubs) {
            const snap = {
                async getSnapshot(){ return { validators }; },
                // WI-1: the transport signer-set refresh, Consensus, and XChainHub
                // resolve the active federation set from getActiveValidatorSnapshot.
                // These in-process hubs run with network='' → legacy count quorum,
                // so the equal-stake count set mirrors getSnapshot.
                async getActiveValidatorSnapshot(){ return { validators, count: validators.length }; },
            };
            hub.capabilitySnapshot = snap;                    // _getActiveOraclePublishPubkeys
            hub.stateAnchorPublisher.capSnapshot = snap;      // _resolveCapabilitySet (constructor-captured)
            // AT5 reads the mined bundle back through the DOGE indexer's
            // getanchoraction, which is the ONLY path _findExistingBundle has. An
            // unwired indexer makes every lookup "undetermined", and a returning
            // rank 0 would then spend a second time instead of adopting, which is
            // precisely what AT5 exists to disprove.
            hub.stateAnchorPublisher.indexers = hub.stateAnchorPublisher.indexers || {};
            hub.stateAnchorPublisher.indexers.DOGE = {
                url: indexerConnector.url,
                key: process.env.INDEXER_API_KEY || ''
            };
        }

        // One funded wallet per hub (separate keys, separate UTXO sets).
        for (let i = 0; i < N; i++) {
            wallets.push(await cryptoHelper.getNewFundedAddress('elect-pub-' + i, COIN, NETWORK, null, 'legacy', 0, 3.0));
        }
        await regtestMinerConnector.generateBlocks(2);
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });

        // Per-hub broadcast hook: the production two-phase P2SH pipeline
        // (encode → signPsbt → broadcast → spendP2sh → signRevealPsbt →
        // broadcast) signing with THAT hub's wallet, plus regtest mining so
        // the tracker sees fresh UTXOs between publishes.
        const network = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK);
        for (let i = 0; i < N; i++) {
            const addr   = wallets[i].address;
            const wifStr = wifEncode(network.wif, Buffer.from(wallets[i].privateKey), true);
            const hubIdx = i;
            mvh.hubs[i].stateAnchorPublisher.setBroadcastHook(async (payload) => {
                const encoder = sdk._requireEncoder();
                // The tracker can be a beat behind right after a publish/mint
                // confirms (same staleness transactionHelper's trap handles, and
                // production absorbs via the flush timer); quiesce and retry.
                let tx = null;
                for (let attempt = 1; ; attempt++) {
                    try {
                        tx = await encoder.createTx({ data: payload, pubkey: addr, change: addr, encoding: 'P2SH' });
                        break;
                    } catch (e) {
                        if (attempt >= 6) throw e;
                        console.log('    [hub ' + hubIdx + '] createTx retry ' + attempt + ' (' + (e && e.message) + ')');
                        await regtestMinerConnector.generateBlocks(1);
                        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
                        await sleep(1500);
                    }
                }
                const signed = sdk.wallet.signPsbt(tx.psbt, wifStr);
                await encoder.broadcastTx(signed.txHex);
                let txid = signed.txid, phase1 = null;
                if (tx.encoding === 'P2SH' || tx.encoding === 'P2WSH') {
                    const spend = await encoder.spendP2sh({
                        pubkey: addr, p2shHash: signed.txid, p2shHex: signed.txHex,
                        data: payload, encoding: tx.encoding, change: addr
                    });
                    const rs = sdk.wallet.signRevealPsbt(spend.psbt, wifStr);
                    await encoder.broadcastTx(rs.txHex);
                    phase1 = txid; txid = rs.txid;
                }
                published.push({ hub: hubIdx, payload, txid, phase1_txid: phase1, from: addr });
                await regtestMinerConnector.generateBlocks(1);
                await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
                return { txid };
            });
            mvh.hubs[i].rewardTracker = {
                // Signature mirrors StateAnchorPublisher._recordReward: (type, round,
                // pubkey, blockIndex, network). `network` is threaded so the real
                // RewardTracker's derive-vs-push gate reads the checkpoint's network;
                // it is recorded here so a test can see it, not branched on.
                recordAnchorReward: async (type, round, pubkey, blk, net) => {
                    // Every hub records the reward: the publisher at publish time
                    // and each peer from the signature-verified BUNDLE_DONE /
                    // FINALIZED (sender = the publisher's pubkey). Production
                    // collapses these in the shared DB (RewardTracker.recordAnchorReward):
                    // one row per (reward_type, round_number), lexicographically-smallest
                    // pubkey wins, same-pubkey idempotent. Mirror that here:
                    // in-proc hubs share this one `rewards` array.
                    const pk = String(pubkey).toLowerCase();
                    const cur = rewards.find(r => r.type === type && r.round === round);
                    if (cur) { if (pk < cur.pubkey) { cur.pubkey = pk; cur.hub = hubIdx; } return; }
                    rewards.push({ hub: hubIdx, type, round, pubkey: pk, blk, network: net });
                }
            };
        }
    });

    after(async function () {
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
    });

    it('AT1: one flush lands ONE v0 bundle carrying all three chains, one election, one anchor_bundle reward, every hub stamped', async function () {
        const block = await waitForTip(0);

        // All three chains at the SAME snapshot_block: the steady state, where the
        // bundle's SNAPSHOT_BLOCK (D6, MAX over sections) equals every section's own.
        for (const chain of ['BTC', 'LTC', 'DOGE']) {
            const row = syntheticCheckpoint(chain, await nextSeq(chain), block);
            cpRows.push(row);
            await insertCheckpointEverywhere(row);
        }

        const order  = rankOrder('regtest', block);
        const winner = order[0];
        console.log('    bundle key ' + bundleKey('regtest', block) + ' → rank order hub' + order.join(', hub'));
        const axios = require('axios');
        for (let i = 0; i < N; i++) {
            const resp = await axios.post('http://' + (process.env.UTXO_TRACKER_URL || 'localhost') + ':' +
                (process.env.UTXO_TRACKER_API_PORT || '3121') + '/',
                { jsonrpc: '2.0', id: 1, method: 'get_utxos', params: { address: wallets[i].address } },
                { timeout: 10000 });
            const utxos = (resp.data.result && resp.data.result.utxos) || [];
            console.log('    hub ' + i + ' wallet ' + wallets[i].address + ': ' + utxos.length + ' utxo(s), confs [' +
                utxos.map(u => u.confirmations).join(',') + ']');
        }

        // Every hub's flush timer would fire in production; fire them all. Only the
        // bundle key's rank 0 is unlocked, so exactly one of them may spend.
        for (const hub of mvh.hubs) await hub.stateAnchorPublisher.flush();
        await waitForAnchorBackfill(cpRows, mvh.hubs, 30000);

        // ONE bundle, not one per chain. This is the whole point of the rail change:
        // the pre-bundle publisher produced three transactions here.
        const bs = bundles();
        assert.strictEqual(bs.length, 1,
            'exactly one ANCHOR v0 for the network, got ' + bs.length + ' (' +
            bs.map(b => b.bundle.chains.join('+')).join(' / ') + ')');
        const bundle = bs[0];
        assert.strictEqual(bundle.hub, winner, 'published by the bundle key\'s hash-order rank 0');
        assert.strictEqual(bundle.from, wallets[winner].address, 'paid from the winner\'s own wallet');
        assert.ok(bundle.phase1_txid && bundle.phase1_txid !== bundle.txid, 'two-phase publish');

        // Three sections, chain-ascending (D5), one per pending chain, all at the
        // bundle's own snapshot_block.
        assert.strictEqual(bundle.bundle.section_count, 3, 'three sections');
        assert.deepStrictEqual(bundle.bundle.chains, ['BTC', 'DOGE', 'LTC'],
            'sections ride CHAIN ascending');
        assert.strictEqual(bundle.bundle.network, 'regtest');
        assert.strictEqual(bundle.bundle.snapshot_block, block, 'header SNAPSHOT_BLOCK is the sections\' MAX');
        for (const s of bundle.bundle.sections) {
            const mine = cpRows.find(r => r.chain === s.chain);
            assert.strictEqual(s.checkpoint_seq, mine.checkpoint_seq, s.chain + ': section carries its own seq');
            assert.strictEqual(s.section_snapshot_block, mine.snapshot_block, s.chain + ': section carries its own snapshot block');
            assert.strictEqual(String(s.state_root).toLowerCase(), String(mine.state_root).toLowerCase(),
                s.chain + ': section is root-bearing');
        }

        // ONE reward for the whole bundle, keyed on the bundle's snapshot block, not
        // one per chain. The `anchor_<CHAIN>` types no longer exist.
        assert.ok(bundle.bundle.attest_sig_count >= 1,
            'the publisher attestation round reached quorum (ATTEST_SIG_COUNT ' +
            bundle.bundle.attest_sig_count + '); without it the anchor still lands but no reward is derived');
        const bundleRewards = rewards.filter(r => r.type === 'anchor_bundle' && r.round === block);
        assert.strictEqual(bundleRewards.length, 1, 'exactly one anchor_bundle reward record for this bundle');
        assert.strictEqual(bundleRewards[0].pubkey, pubkeys[winner], 'reward credited to the winner');
        for (const chain of ['BTC', 'LTC', 'DOGE'])
            assert.strictEqual(rewards.filter(r => r.type === 'anchor_' + chain).length, 0,
                'no per-chain anchor_' + chain + ' reward is written any more');

        // Every hub holds the SAME txid on ALL THREE section rows (XANC_BUNDLE_DONE
        // carries the section list, so a peer stamps the whole set from one message).
        for (const row of cpRows) {
            for (let i = 0; i < N; i++) {
                const r = await mvh.hubs[i].db.doQuery(
                    'SELECT anchor_txid FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ?',
                    [row.chain, row.network, row.block_index]);
                assert.ok(r.length === 1 && r[0].anchor_txid, row.chain + ': hub ' + i + ' back-filled via BUNDLE_DONE');
                assert.strictEqual(String(r[0].anchor_txid), bundle.txid, row.chain + ': hub ' + i + ' holds the bundle txid');
            }
        }

        // Idempotency: with everything back-filled, nobody re-anchors.
        const count = published.length;
        for (const hub of mvh.hubs) {
            const s = await hub.stateAnchorPublisher.flush();
            assert.strictEqual(s.anchored.length, 0);
        }
        assert.strictEqual(published.length, count, 'no double-anchoring after back-fill');

        console.log('    bundle: hub' + winner + ' [' + bundle.bundle.chains.join(',') + '] @ ' + block +
                    ' txid ' + bundle.txid + ' (' + bundle.bundle.attest_sig_count + ' attesting sig(s))');
    });

    it('AT3: a chain whose newest eligible checkpoint is already anchored is ABSENT, the bundle is short, and it rejoins at its newer seq', async function () {
        // AT1 anchored all three. Now BTC and DOGE cut a new checkpoint and LTC does
        // not (on the venue: its indexer is stopped, so no new row is cut at all).
        // LTC's MAX un-anchored seq does not exist, so it is absent - and per D4 that
        // is the NORMAL daily case, never a reason to hold the bundle.
        const block = await waitForTip(0);
        const pair  = [];
        for (const chain of ['BTC', 'DOGE']) {
            const prev = cpRows.find(r => r.chain === chain);
            const row  = syntheticCheckpoint(chain, prev.checkpoint_seq + 1, block);
            pair.push(row);
            await insertCheckpointEverywhere(row);
        }

        const before = bundles().length;
        for (const hub of mvh.hubs) await hub.stateAnchorPublisher.flush();
        await waitForAnchorBackfill(pair, mvh.hubs, 30000);

        const fresh = bundles().slice(before);
        assert.strictEqual(fresh.length, 1, 'the short bundle published, exactly once');
        assert.strictEqual(fresh[0].bundle.section_count, 2, 'TWO sections: LTC has nothing new to anchor');
        assert.deepStrictEqual(fresh[0].bundle.chains, ['BTC', 'DOGE'], 'still chain-ascending');
        assert.strictEqual(fresh[0].bundle.snapshot_block, block);

        // LTC rejoins the moment it cuts a newer un-anchored seq. Nothing had to be
        // reset or replayed: the selector picks it up on the next cycle.
        const ltcPrev = cpRows.find(r => r.chain === 'LTC');
        const ltcNew  = syntheticCheckpoint('LTC', ltcPrev.checkpoint_seq + 1, block);
        await insertCheckpointEverywhere(ltcNew);

        const before2 = bundles().length;
        for (const hub of mvh.hubs) await hub.stateAnchorPublisher.flush();
        await waitForAnchorBackfill([ltcNew], mvh.hubs, 30000);

        const rejoin = bundles().slice(before2);
        assert.strictEqual(rejoin.length, 1, 'the catch-up bundle published, exactly once');
        assert.deepStrictEqual(rejoin[0].bundle.chains, ['LTC'],
            'LTC alone: BTC and DOGE were anchored by the short bundle above');
        assert.strictEqual(rejoin[0].bundle.sections[0].checkpoint_seq, ltcNew.checkpoint_seq,
            'LTC rejoined at its NEWER seq, not the one already on chain');
        console.log('    AT3: [' + fresh[0].bundle.chains.join(',') + '] then [' +
                    rejoin[0].bundle.chains.join(',') + '] at seq ' + ltcNew.checkpoint_seq);
    });

    it('AT5: ranks stay locked in-window, rank 1 takes over, and a returning rank 0 adopts by per-section lookup with no second spend', async function () {
        const block = await waitForTip(0);
        // A fresh single-chain bundle so the failover has something pending. BTC's
        // previous seq came from the AT3 pair.
        const prevSeq = (await indexerQuery(
            "SELECT COALESCE(MAX(checkpoint_seq), -1) AS s FROM anchor_actions WHERE chain = 'BTC' AND network = 'regtest'"))[0].s;
        const row = syntheticCheckpoint('BTC', Number(prevSeq) + 1, block);
        await insertCheckpointEverywhere(row);

        const order = rankOrder('regtest', block);
        for (const hub of mvh.hubs) hub.stateAnchorPublisher.electionToleranceBlocks = 2;

        // Inside the window (since ≈ 0): every rank but 0 is locked.
        const before = bundles().length;
        for (const r of order.slice(1)) await mvh.hubs[r].stateAnchorPublisher.flush();
        assert.strictEqual(bundles().length, before, 'higher ranks locked inside the tolerance window');

        // Window elapses without rank 0 (it never flushes) → rank 1 unlocks.
        await regtestMinerConnector.generateBlocks(3);
        await waitForTip(block + 3);
        await mvh.hubs[order[1]].stateAnchorPublisher.flush();
        const failover = bundles().slice(before);
        assert.strictEqual(failover.length, 1, 'rank 1 published the failover bundle');
        assert.strictEqual(failover[0].hub, order[1]);
        assert.strictEqual(failover[0].from, wallets[order[1]].address, 'failover paid from rank 1\'s wallet');
        assert.deepStrictEqual(failover[0].bundle.chains, ['BTC']);

        // BYTE DETERMINISM (D5): rank 0 rebuilds the same bundle from ITS OWN rows and
        // must produce the same bytes rank 1 put on the wire. _parseSigs returns the
        // stored JSON order unsorted, so without the inner PUBKEY sort two publishers
        // racing this bundle emit different bytes and the attestation round's DB
        // byte-match stops being deterministic.
        const mineRank0 = await mvh.hubs[order[0]].db.doQuery(
            'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND checkpoint_seq = ?',
            [row.chain, row.network, row.checkpoint_seq]);
        const rebuilt = mvh.hubs[order[0]].stateAnchorPublisher._buildV7Payload(
            mineRank0, pubkeys[order[1]], failover[0].bundle.attestSigs);
        assert.strictEqual(rebuilt, failover[0].payload,
            'rank 0 rebuilds byte-identical bundle bytes for the same state');

        // Rank 0 "comes back" having MISSED the announcement: clear its stamp so the
        // back-fill cannot be what saves it, and make it flush. The only thing left to
        // stop a second spend is _findExistingBundle's per-section getanchoraction
        // against the mined transaction, which is exactly what AT5 asserts.
        assert.ok(await waitForBundleIndexed([row], 120000),
            'the DOGE indexer parsed and stored the failover bundle\'s section row');
        await mvh.hubs[order[0]].db.doQuery(
            'UPDATE state_checkpoints SET anchor_txid = NULL WHERE chain = ? AND network = ? AND checkpoint_seq = ?',
            [row.chain, row.network, row.checkpoint_seq]);

        const count = bundles().length;
        const s = await mvh.hubs[order[0]].stateAnchorPublisher.flush();
        assert.strictEqual(bundles().length, count, 'returning rank 0 did NOT spend a second time');
        // The adopt path stamps the row with the txid it found on chain rather than
        // leaving it pending, so the fleet converges on one txid.
        const after = await mvh.hubs[order[0]].db.doQuery(
            'SELECT anchor_txid FROM state_checkpoints WHERE chain = ? AND network = ? AND checkpoint_seq = ?',
            [row.chain, row.network, row.checkpoint_seq]);
        assert.strictEqual(String(after[0].anchor_txid).toLowerCase(), String(failover[0].txid).toLowerCase(),
            'rank 0 adopted rank 1\'s txid through the per-section lookup');
        assert.ok(Array.isArray(s.anchored), 'flush returned a summary');
        console.log('    AT5: rank1 hub' + order[1] + ' published ' + failover[0].txid +
                    '; rank0 hub' + order[0] + ' adopted it without spending');
    });

    it('archive: the per-block leader collects 2f+1 live co-signatures and XANC_FINALIZED back-fills every hub', async function () {
        const identities = mvh.identities.map(id => new ValidatorIdentity(id.privkeyHex));
        const block = await waitForTip(0);

        // Identical finalized match on every hub, signed by 3/4 validators
        // (the followers' cryptographic check needs 2f+1 over XMATCH).
        const m = {
            match_id: crypto.createHash('sha256').update('anchor-election-' + Date.now()).digest('hex'),
            snapshot_block: block, network: 'regtest',
            a_chain: 'DOGE', a_action_index: 11, a_kind: 'swap', a_tick: 'TOKA', a_amount: '1000',
            a_filled_before: '0', a_ownership: 0, a_payout_addr: 'election_payout_a',
            b_chain: 'LTC', b_action_index: 22, b_kind: 'swap', b_tick: 'TOKB', b_amount: '2000',
            b_filled_before: '0', b_ownership: 0, b_payout_addr: 'election_payout_b',
            effective_time: Math.floor(Date.now() / 1000)
        };
        const canonical = mvh.hubs[0].getCrossChainDex()._canonicalMatch(m);
        const sigs = JSON.stringify(identities.slice(0, 3).map(id =>
            ({ pubkey: id.getPubkeyHex().toLowerCase(), sig: id.sign(canonical) })));
        await allHubs(
            `INSERT INTO cross_chain_matches
                (match_id, snapshot_block, network, a_chain, a_action_index, a_kind, a_tick, a_amount,
                 a_filled_before, a_ownership, a_payout_addr, b_chain, b_action_index, b_kind, b_tick,
                 b_amount, b_filled_before, b_ownership, b_payout_addr, effective_time,
                 validator_signatures, status)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'finalized')`,
            [m.match_id, m.snapshot_block, m.network, m.a_chain, m.a_action_index, m.a_kind, m.a_tick,
             m.a_amount, m.a_filled_before, m.a_ownership, m.a_payout_addr, m.b_chain, m.b_action_index,
             m.b_kind, m.b_tick, m.b_amount, m.b_filled_before, m.b_ownership, m.b_payout_addr,
             m.effective_time, sigs]);

        const electionBlock = await waitForTip(0);
        // The failover test mutated electionToleranceBlocks to 2; reset to a wide
        // window so only rank 0 (the leader) is unlocked and every other hub
        // refuses (deterministic single-leader election).
        for (const hub of mvh.hubs) hub.stateAnchorPublisher.electionToleranceBlocks = 100000;

        // Elect the leader EXACTLY as _startArchiveRound does: hash-order over the
        // oracle_publish set keyed on _archiveElectionKey(wrapperCp, nextBatchSeq).
        // The wrapper is the BTC-preferred latest checkpoint; batchSeq is a
        // non-consuming MAX+1 read, identical on every hub. The archive leg is
        // UNCHANGED by the bundle (it was already one head per network per cycle).
        const sap0 = mvh.hubs[0].stateAnchorPublisher;
        const cpRow = (await mvh.hubs[0].db.doQuery(
            "SELECT * FROM state_checkpoints ORDER BY (chain = 'BTC') DESC, id DESC LIMIT 1"))[0];
        const batchSeq = await sap0._getNextBatchSeq();
        const archiveKey = sap0._archiveElectionKey(
            { chain: cpRow.chain, network: cpRow.network, checkpoint_seq: cpRow.checkpoint_seq }, batchSeq);
        const archiveOrder = SAP.hashOrder(archiveKey, pubkeys);
        const leader = pubkeys.indexOf(archiveOrder[0]);
        const nonLeader = pubkeys.indexOf(archiveOrder[archiveOrder.length - 1]);

        const sNon = await mvh.hubs[nonLeader].stateAnchorPublisher.flush();
        assert.strictEqual(sNon.archive, 'none', 'a non-leader refuses to start the archive round');

        const sLead = await mvh.hubs[leader].stateAnchorPublisher.flush();
        assert.ok(sLead.archive === 'round_started' || sLead.archive === 'published',
            'leader started the round (got ' + sLead.archive + ')');
        // SIGN round + publish + FINALIZED: wait for the finalized back-fill to
        // reach every hub rather than a fixed window.
        await waitForArchiveFinalized(m.match_id, mvh.hubs, 60000);

        // The archive leg now has exactly one accepted version (D4): v1, with
        // the publisher tail ALWAYS appended, whether or not archive-reward
        // derivation is armed at the checkpoint's snapshot_block. There is no
        // second, tail-less wire to fall back to any more.
        const arcVersions = anchorVersions.expectedArchiveAnchor(cpRow).accepted;
        const v1s = published.filter(p => arcVersions.includes(anchorVersions.anchorPayloadVersion(p.payload)));
        assert.strictEqual(v1s.length, 1, 'exactly one archive anchor published');
        assert.strictEqual(v1s[0].hub, leader, 'published by the elected archive leader');
        assert.strictEqual(v1s[0].from, wallets[leader].address, 'paid from the leader\'s wallet');

        const f = v1s[0].payload.split('|');
        const sigCount = Number(f[16]);
        assert.ok(sigCount >= 3, 'the archive anchor carries 2f+1 live co-signatures (got ' + sigCount + ')');

        assert.ok(rewards.some(r => r.hub === leader && r.type === 'anchor_archive'),
            'archive reward credited to the leader');

        for (let i = 0; i < N; i++) {
            const r = await mvh.hubs[i].db.doQuery(
                'SELECT batch_seq, archived_status FROM cross_chain_matches WHERE match_id = ?', [m.match_id]);
            assert.ok(r.length === 1 && r[0].batch_seq != null && String(r[0].archived_status) === 'finalized',
                'hub ' + i + ' back-filled batch metadata via XANC_FINALIZED');
        }
        console.log('    archive: leader hub' + leader + ', ' + sigCount + ' sigs, txid ' + v1s[0].txid);
    });
});
