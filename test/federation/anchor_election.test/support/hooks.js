/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const cryptoHelper   = require('../../../helpers/core/cryptoHelper');
const { makeSdk }    = require('../../../sdk/helpers/sdkHelper');
const { wifEncodeFor } = require('./wif');
const { MultiValidatorHub, loadHubModule } = require('../../../helpers/multiValidatorHubHelper');
const { N, sleep, S } = require('./state');

// Full-set capability stubs below; make sure the local-seed seam from
// other suites/processes can't shadow them.
function configureEnv(){
    delete process.env.XDEX_SEED_LOCAL_VALIDATOR;
    process.env.ANCHOR_INTERVAL_MS   = '600000000';            // manual flush only
    process.env.CHECKPOINT_POLL_MS   = '600000000';            // no engine ticks
    process.env.CHECKPOINT_CHAINS    = 'DOGE';
    process.env.ANCHOR_ELECTION_TOLERANCE_BLOCKS = '100000';   // phase 1: only rank 0 unlocks
}

// Identical deterministic oracle_publish/cross_chain set on every hub.
function stubCapabilities(){
    const validators = S.pubkeys.map(pk => ({ pubkey: pk, amount: '1' }));
    for (const hub of S.mvh.hubs) {
        const snap = {
            async getSnapshot(){ return { validators }; },
            // The transport signer-set refresh, Consensus, and XChainHub
            // resolve the active federation set from getActiveValidatorSnapshot.
            // These in-process hubs run with network='' -> legacy count quorum,
            // so the equal-stake count set mirrors getSnapshot.
            async getActiveValidatorSnapshot(){ return { validators, count: validators.length }; },
        };
        hub.capabilitySnapshot = snap;                    // getActiveOraclePublishPubkeys
        hub.stateAnchorPublisher.capSnapshot = snap;      // resolveCapabilitySet (constructor-captured)
        // AT5 reads the mined bundle back through the DOGE indexer's
        // getanchoraction, which is the ONLY path findExistingBundle has. An
        // unwired indexer makes every lookup "undetermined", and a returning
        // rank 0 would then spend a second time instead of adopting, which is
        // precisely what AT5 exists to disprove.
        hub.stateAnchorPublisher.indexers = hub.stateAnchorPublisher.indexers || {};
        hub.stateAnchorPublisher.indexers.DOGE = {
            url: indexerConnector.url,
            key: process.env.INDEXER_API_KEY || ''
        };
    }
}

async function bootHubs(){
    S.SAP = loadHubModule('src/anchor/publisher.js');
    S.sdk = makeSdk();
    S.mvh = new MultiValidatorHub({
        count: N, basePort: 34300,
        startCrossChain: true, startAttestation: false,
        dbNamePrefix: 'XChain_DOGE_Regtest_ELECT_' + process.pid + '_'
    });
    await S.mvh.start();
    S.pubkeys = S.mvh.getPubkeys().map(p => p.toLowerCase());
    stubCapabilities();
}

// One funded wallet per hub (separate keys, separate UTXO sets).
async function fundWallets(){
    for (let i = 0; i < N; i++) {
        S.wallets.push(await cryptoHelper.getNewFundedAddress('elect-pub-' + i, COIN, NETWORK, null, 'legacy', 0, 3.0));
    }
    await regtestMinerConnector.generateBlocks(2);
    await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
}

// The tracker can be a beat behind right after a publish/mint confirms (same
// staleness transactionHelper's trap handles, and production absorbs via the
// flush timer); quiesce and retry.
async function createTxWithRetry(encoder, hubIdx, payload, addr){
    for (let attempt = 1; ; attempt++) {
        try {
            return await encoder.createTx({ data: payload, pubkey: addr, change: addr, encoding: 'P2SH' });
        } catch (e) {
            if (attempt >= 6) throw e;
            console.log('    [hub ' + hubIdx + '] createTx retry ' + attempt + ' (' + (e && e.message) + ')');
            await regtestMinerConnector.generateBlocks(1);
            await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
            await sleep(1500);
        }
    }
}

// The production two-phase P2SH pipeline (encode -> signPsbt -> broadcast ->
// spendP2sh -> signRevealPsbt -> broadcast) signing with THAT hub's wallet.
async function publishTwoPhase(hubIdx, payload){
    const addr   = S.wallets[hubIdx].address;
    const wifStr = wifEncodeFor(S.wallets[hubIdx]);
    const encoder = S.sdk.requireEncoder();
    const tx = await createTxWithRetry(encoder, hubIdx, payload, addr);
    const signed = S.sdk.wallet.signPsbt(tx.psbt, wifStr);
    await encoder.broadcastTx(signed.txHex);
    let txid = signed.txid, phase1 = null;
    if (tx.encoding === 'P2SH' || tx.encoding === 'P2WSH') {
        const spend = await encoder.spendP2sh({
            pubkey: addr, p2shHash: signed.txid, p2shHex: signed.txHex,
            data: payload, encoding: tx.encoding, change: addr
        });
        const rs = S.sdk.wallet.signRevealPsbt(spend.psbt, wifStr);
        await encoder.broadcastTx(rs.txHex);
        phase1 = txid; txid = rs.txid;
    }
    S.published.push({ hub: hubIdx, payload, txid, phase1_txid: phase1, from: addr });
    return txid;
}

// Per-hub broadcast hook: the two-phase publish above, plus regtest mining so
// the tracker sees fresh UTXOs between publishes.
function broadcastHookFor(hubIdx){
    return async (payload) => {
        const txid = await publishTwoPhase(hubIdx, payload);
        await regtestMinerConnector.generateBlocks(1);
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
        return { txid };
    };
}

// Signature mirrors StateAnchorPublisher._recordReward: (type, round,
// pubkey, blockIndex, network). `network` is threaded so the real
// RewardTracker's derive-vs-push gate reads the checkpoint's network;
// it is recorded here so a test can see it, not branched on.
function rewardTrackerFor(hubIdx){
    return {
        recordAnchorReward: async (type, round, pubkey, blk, net) => {
            // Every hub records the reward: the publisher at publish time
            // and each peer from the signature-verified BUNDLE_DONE /
            // FINALIZED (sender = the publisher's pubkey). Production
            // collapses these in the shared DB (RewardTracker.recordAnchorReward):
            // one row per (reward_type, round_number), lexicographically-smallest
            // pubkey wins, same-pubkey idempotent. Mirror that here:
            // in-proc hubs share this one `rewards` array.
            const pk = String(pubkey).toLowerCase();
            const cur = S.rewards.find(r => r.type === type && r.round === round);
            if (cur) { if (pk < cur.pubkey) { cur.pubkey = pk; cur.hub = hubIdx; } return; }
            S.rewards.push({ hub: hubIdx, type, round, pubkey: pk, blk, network: net });
        }
    };
}

function wirePublishers(){
    for (let i = 0; i < N; i++) {
        S.mvh.hubs[i].stateAnchorPublisher.setBroadcastHook(broadcastHookFor(i));
        S.mvh.hubs[i].rewardTracker = rewardTrackerFor(i);
    }
}

// Suite hooks, registered inside the parent describe.
function installHooks(){
    before(async function () {
        configureEnv();
        await bootHubs();
        await fundWallets();
        wirePublishers();
    });

    after(async function () {
        if (S.mvh) { await S.mvh.stop(); await S.mvh.dropDatabases(); }
    });
}

module.exports = { installHooks };
