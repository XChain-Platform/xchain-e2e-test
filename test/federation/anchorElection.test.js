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
 * E2E: per-chain ANCHOR publisher ELECTION on a LIVE DOGE regtest chain.
 *
 * The multi-validator paths the single-validator mainnet deployment never
 * exercises: four hubs over REAL P2P (Ed25519-verified gossip, per-hub
 * MariaDB), each with its OWN funded regtest DOGE wallet, electing
 * per-chain publishers by hash-ordering and publishing REAL two-phase
 * P2SH transactions. Verifies:
 *
 *   1. Per-chain election: each pending checkpoint is anchored exactly
 *      once, by the hash-order rank-0 validator for that row's key, paid
 *      from that validator's own wallet (no shared-UTXO contention).
 *   2. XANC_V0_DONE back-fill: every other hub's copy of the row gets
 *      anchor_txid over live P2P; a second flush publishes nothing.
 *   3. Failover ladder: ranks above 0 stay locked inside the tolerance
 *      window, rank 1 takes over after it elapses, and the returning
 *      rank 0 does NOT double-anchor (back-fill won the race).
 *   4. Archive round: the per-election-block leader collects 2f+1
 *      co-signatures from followers verifying against their own DBs,
 *      publishes ANCHOR v1, and XANC_FINALIZED back-fills every hub.
 *   5. Rewards: only the winning publisher records anchor_<chain> /
 *      anchor_archive rewards.
 *
 * The oracle_publish capability set is stubbed (identical 4-validator
 * snapshot on every hub): resolving REAL on-chain BTC stakes into
 * snapshots is CapabilitySnapshot's own concern, covered by its units
 * and the Tier-2 federation proof. Everything downstream of the set
 * (election, gossip, signing, broadcast, DB state) is live.
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

describe('ANCHOR election live: multi-validator per-chain publishers (DOGE regtest)', function () {
    this.timeout(20 * 60 * 1000);

    let mvh = null, sdk = null, SAP = null;
    let wallets   = [];   // funded addressInfo per hub, hub order
    let pubkeys   = [];   // lowercase signing pubkeys, hub order
    let published = [];   // { hub, payload, txid, phase1_txid, from }
    let rewards   = [];   // { hub, type, round, pubkey }
    let cpRows    = [];   // synthetic checkpoints shared across the suite

    function v0Key(row){
        return 'XANCV0|' + row.chain + '|' + row.network + '|' + row.checkpoint_seq + '|' + row.snapshot_block;
    }
    function rankOrder(row){                      // hub indices by election rank
        return SAP.hashOrder(v0Key(row), pubkeys).map(pk => pubkeys.indexOf(pk));
    }

    async function indexerQuery(sql, params){
        let conn = await indexerDatabase.getConnection();
        try { return await conn.query(sql, params); }
        finally { await conn.release(); }
    }

    async function allHubs(sql, params){
        for (const hub of mvh.hubs) await hub.db.doQuery(sql, params);
    }

    // Poll until the XANC_V0_DONE back-fill has landed: every named hub's copy of
    // every row carries anchor_txid. Waiting on the back-fill itself rather than a
    // fixed settle costs time on a slow gossip round instead of a false failure.
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
            'actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [row.chain, row.network, row.block_index, row.block_hash, row.ledger_hash,
             row.actions_hash, row.contract_hash, row.checkpoint_seq, row.snapshot_block, row.validator_signatures]);
    }

    function syntheticCheckpoint(chain, seq, snapshotBlock){
        return {
            chain, network: 'regtest', block_index: 100000 + seq,
            block_hash:    crypto.randomBytes(32).toString('hex'),
            ledger_hash:   crypto.randomBytes(32).toString('hex'),
            actions_hash:  crypto.randomBytes(32).toString('hex'),
            contract_hash: crypto.randomBytes(32).toString('hex'),
            checkpoint_seq: seq, snapshot_block: snapshotBlock, validator_signatures: '[]'
        };
    }

    // Seqs must clear the indexer's per-chain replay guard (dirty regtest
    // chains carry anchors from prior runs).
    async function nextSeq(chain){
        let r = await indexerQuery(
            'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS s FROM anchor_actions WHERE chain = ? AND network = ?',
            [chain, 'regtest']);
        return Number(r[0].s);
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
                recordAnchorReward: async (type, round, pubkey, blk) => {
                    // Every hub records the reward: the publisher at publish time
                    // and each peer from the signature-verified V0_DONE / FINALIZED
                    // (sender = the publisher's pubkey). Production collapses these
                    // in the shared DB (RewardTracker.recordAnchorReward): one row
                    // per (reward_type, round_number), lexicographically-smallest
                    // pubkey wins, same-pubkey idempotent. Mirror that here:
                    // in-proc hubs share this one `rewards` array.
                    const pk = String(pubkey).toLowerCase();
                    const cur = rewards.find(r => r.type === type && r.round === round);
                    if (cur) { if (pk < cur.pubkey) { cur.pubkey = pk; cur.hub = hubIdx; } return; }
                    rewards.push({ hub: hubIdx, type, round, pubkey: pk, blk });
                }
            };
        }
    });

    after(async function () {
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
    });

    it('elects one publisher per chain (rank 0 of each key), paying from its own wallet; V0_DONE back-fills every hub', async function () {
        const block = await waitForTip(0);

        for (const chain of ['BTC', 'LTC', 'DOGE']) {
            const row = syntheticCheckpoint(chain, await nextSeq(chain), block);
            cpRows.push(row);
            await insertCheckpointEverywhere(row);
        }

        // Pre-flush diagnostics: winner map + each wallet's tracker view.
        console.log('    winners: ' + cpRows.map(r => r.chain + '→hub' + rankOrder(r)[0]).join(', '));
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

        // Every hub's flush timer would fire in production; fire them all.
        for (const hub of mvh.hubs) await hub.stateAnchorPublisher.flush();
        // V0_DONE propagation: wait for the back-fill the assertions below read,
        // not a fixed window.
        await waitForAnchorBackfill(cpRows, mvh.hubs, 30000);

        for (const row of cpRows) {
            const order = rankOrder(row);
            const winner = order[0];
            const pubs = published.filter(p => {
                const f = p.payload.split('|'); return f[1] === '0' && f[2] === row.chain;
            });
            assert.strictEqual(pubs.length, 1, row.chain + ': exactly one v0 published');
            assert.strictEqual(pubs[0].hub, winner, row.chain + ': published by hash-order rank 0');
            assert.strictEqual(pubs[0].from, wallets[winner].address, row.chain + ': paid from the winner\'s own wallet');
            assert.ok(pubs[0].phase1_txid && pubs[0].phase1_txid !== pubs[0].txid, row.chain + ': two-phase publish');

            assert.strictEqual(rewards.filter(r => r.type === 'anchor_' + row.chain).length, 1,
                row.chain + ': exactly one reward record');
            assert.ok(rewards.some(r => r.hub === winner && r.type === 'anchor_' + row.chain &&
                r.round === row.checkpoint_seq && r.pubkey === pubkeys[winner]),
                row.chain + ': reward credited to the winner');

            for (let i = 0; i < N; i++) {
                const r = await mvh.hubs[i].db.doQuery(
                    'SELECT anchor_txid FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ?',
                    [row.chain, row.network, row.block_index]);
                assert.ok(r.length === 1 && r[0].anchor_txid, row.chain + ': hub ' + i + ' back-filled via V0_DONE');
                assert.strictEqual(String(r[0].anchor_txid), pubs[0].txid, row.chain + ': hub ' + i + ' holds the real txid');
            }
        }

        // Idempotency: with everything back-filled, nobody re-anchors.
        const count = published.length;
        for (const hub of mvh.hubs) {
            const s = await hub.stateAnchorPublisher.flush();
            assert.strictEqual(s.anchored.length, 0);
        }
        assert.strictEqual(published.length, count, 'no double-anchoring after back-fill');

        console.log('    election spread: ' + cpRows.map(r => r.chain + '→hub' + rankOrder(r)[0]).join(', '));
    });

    it('failover ladder: higher ranks stay locked in-window, rank 1 takes over after it, rank 0 returns to a back-filled row', async function () {
        const block = await waitForTip(0);
        const btcRow = cpRows.find(r => r.chain === 'BTC');
        const row = syntheticCheckpoint('BTC', btcRow.checkpoint_seq + 1, block);
        await insertCheckpointEverywhere(row);

        const order = rankOrder(row);
        for (const hub of mvh.hubs) hub.stateAnchorPublisher.electionToleranceBlocks = 2;

        // Inside the window (since ≈ 0): every rank but 0 is locked.
        const before = published.length;
        for (const r of order.slice(1)) await mvh.hubs[r].stateAnchorPublisher.flush();
        assert.strictEqual(published.length, before, 'higher ranks locked inside the tolerance window');

        // Window elapses without rank 0 (it never flushes) → rank 1 unlocks.
        await regtestMinerConnector.generateBlocks(3);
        await waitForTip(block + 3);
        await mvh.hubs[order[1]].stateAnchorPublisher.flush();
        // Checkpoint-leg versions come from the flag-days at this row's
        // snapshot_block, not a hardcoded v0: the attestation leg legitimately
        // emits v4/v5 on a venue past the reward thresholds.
        const cpVersions = anchorVersions.expectedCheckpointAnchor(row).accepted;
        const pubs = published.slice(before)
            .filter(p => cpVersions.includes(anchorVersions.anchorPayloadVersion(p.payload)));
        assert.strictEqual(pubs.length, 1, 'rank 1 published the failover anchor');
        assert.strictEqual(pubs[0].hub, order[1]);
        assert.strictEqual(pubs[0].from, wallets[order[1]].address, 'failover paid from rank 1\'s wallet');

        // Rank 0 "comes back": its row was back-filled over P2P → no double-anchor.
        // Wait for that back-fill to reach rank 0 rather than a fixed window; a
        // flush before it arrives is the double-anchor this asserts against.
        await waitForAnchorBackfill([row], [mvh.hubs[order[0]]], 30000);
        const count = published.length;
        const s = await mvh.hubs[order[0]].stateAnchorPublisher.flush();
        assert.strictEqual(s.anchored.length, 0, 'returning rank 0 reports nothing pending');
        assert.strictEqual(published.length, count, 'returning rank 0 did not double-anchor');
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
        // non-consuming MAX+1 read, identical on every hub.
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

        // Archive-leg versions from the flag-days at the checkpoint's
        // snapshot_block (v1, or v6 once archive-reward derivation is armed);
        // v6 is v1 plus a publisher tail, so the field layout below is shared.
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
