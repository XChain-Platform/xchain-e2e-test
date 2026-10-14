/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const assert = require('assert');

const { MultiValidatorHub, ValidatorIdentity } = require('../../../helpers/multiValidatorHubHelper');
const { seedWeightSnapshot } = require('../../../helpers/seededWeightSnapshot');
const { S, N, SNAPSHOT_BLOCK_BASE, ROUND_TIMEOUT_MS } = require('./state');
const { indexerQuery, allHubs } = require('./db');
const { waitForPeering } = require('./waits');

// A fresh two-hub federation: its own snapshot block, its own databases, its own
// capability seed.
async function startHubs(){
    S.federationCount++;
    // Its own snapshot block, so this federation's indexer capability rows are
    // never tallied against another federation's validator keys.
    S.snapshotBlock = SNAPSHOT_BLOCK_BASE + (S.federationCount * 1009);
    S.broadcasts = [];
    S.archiveSignReqSeen = [];
    // Read at engine construction, so it must be set before the hubs start.
    process.env.XDEX_SNAPSHOT_BLOCK = String(S.snapshotBlock);

    S.mvh = new MultiValidatorHub({
        count: N, basePort: 34500 + (S.federationCount * 20),
        startCrossChain: true, startAttestation: false,
        dbNamePrefix: 'XChain_DOGE_Regtest_DEGARC_' + process.pid + '_' + S.federationCount + '_'
    });
    await S.mvh.start();
    S.identities = S.mvh.identities.map(id => new ValidatorIdentity(id.privkeyHex));
    S.pubkeys    = S.mvh.getPubkeys().map(p => p.toLowerCase());

    // Gap (b): on a DOGE-only venue every live capability resolution fails (the
    // hub reads the local indexer as its BTC one), and
    // getActiveOraclePublishPubkeys has no local-table fallback. seedWeightSnapshot
    // patches getWeightSnapshot/getActiveWeightSnapshot on the shared
    // hub.capabilitySnapshot object - the one seam both the election and the
    // signing-set resolution read - and sets hub.network so the WEIGHTED path runs.
    // The default is one DISTINCT SOURCE per booted identity, which is exactly the
    // >= 2-source oracle_publish set AT-F2 requires.
    S.weightSeed = seedWeightSnapshot(S.mvh, { blockIndex: S.snapshotBlock, network: 'regtest' });
}

// Per-hub engine wiring: network, round bound, indexer URL, the wire observer on
// the archive attestation request, and the broadcast hook.
function wireHub(i){
    const sap = S.mvh.hubs[i].stateAnchorPublisher;
    // Every engine caches hub.network ONCE at construction, before
    // seedWeightSnapshot runs; MultiValidatorHub threads HUB_NETWORK, so this is
    // belt-and-braces rather than the load-bearing fix.
    sap.network = 'regtest';
    sap.roundTimeoutMs = ROUND_TIMEOUT_MS;
    sap.electionToleranceBlocks = 100000;
    // verifyAnchorOnChain's ONLY path to the chain. Without it the reward
    // drain answers 'no-indexer' forever and AT-F1's reward record never lands,
    // which would read as a degraded round rather than an unwired test.
    sap.indexers = sap.indexers || {};
    sap.indexers.DOGE = { url: indexerConnector.url, key: process.env.INDEXER_API_KEY || '' };

    // Wire-level observation of the archive attestation request, ABOVE the
    // handler silenceArchiveAttestor replaces. The publisher's listener reads
    // handleMessage at call time, so wrapping the instance method sees every
    // envelope without detaching anything.
    S.archiveSignReqSeen.push(0);
    const idx  = i;
    const orig = sap.handleMessage;
    sap.handleMessage = function (envelope) {
        if (envelope && envelope.type === S.SAP.XANCARCHPUB_SIGN_REQ) S.archiveSignReqSeen[idx]++;
        return orig.call(this, envelope);
    };

    const hubIdx = i;
    sap.setBroadcastHook(async (payload) => {
        const result = await S.signerHooks.broadcastFn(payload);
        S.broadcasts.push({ hub: hubIdx, payload, txid: result.txid, phase1_txid: result.phase1_txid });
        // regtest has no organic blocks, and the tracker must see fresh UTXOs
        // before the next publish of the same cycle.
        await regtestMinerConnector.generateBlocks(1);
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
        return result;
    });
}

// Mirror the capability snapshot into the INDEXER DB.
async function seedIndexerCapabilities(){
    // Mirror the capability snapshot into the INDEXER DB (what hub_db_sync would
    // deliver in a hub-connected deployment) so the ANCHOR handler verifies as
    // 'valid' rather than 'unverified'. BOTH validators, each its own non-blank
    // source: the regtest tally is stake-weighted at genesis and dedupes by
    // DISTINCT source, so a blank one fails closed (WI-1).
    for (const cap of ['oracle_publish', 'cross_chain']) {
        for (const pk of S.pubkeys) {
            await indexerQuery(
                'INSERT INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?) ' +
                'ON DUPLICATE KEY UPDATE amount = VALUES(amount), source = VALUES(source)',
                [S.snapshotBlock, cap, pk, '1', pk]);
        }
    }
    const seeded = await indexerQuery(
        'SELECT capability, signing_pubkey FROM capability_snapshots WHERE snapshot_block = ?', [S.snapshotBlock]);
    assert.strictEqual(seeded.length, 2 * N,
        'both validators are in both capability sets at snapshot block ' + S.snapshotBlock);
}

// The SAME rows in each hub's OWN capability_snapshots.
async function seedHubCapabilities(){
    // The SAME rows in each hub's OWN capability_snapshots, which the indexer-side
    // seed above does not touch (separate databases).
    //
    // The PINNED election path (getActiveOraclePublishPubkeys, which gates the v0
    // bundle) asks hub.capabilitySnapshot first and falls back to this local table on
    // regtest. seedWeightSnapshot covers the accessor the SIGNING-set resolver uses,
    // but the third live drive of this suite showed the pinned path resolving neither:
    // "capability snapshot unavailable AND the local capability_snapshots table has no
    // rows", once per federation, so every publisher abstained from its bundle election
    // and correctly refused to spend a fee on a v0 that would index invalid. Every
    // "the bundle never reached the chain" failure was downstream of that one line.
    // anchorAcceptance's header already names this clause; this is the two-hub form of
    // it, and it is belt-and-braces: whichever branch answers, the answer is now the
    // same set. Rows are IDENTICAL on every hub, which matters beyond the election -
    // the archive carries a capability_snapshots section and a follower byte-compares
    // it against its own rebuild.
    //
    // A NON-BLANK, per-validator source is required, not cosmetic: the stake-weighted
    // tally dedupes by DISTINCT source and fails closed on a blank one (WI-1).
    for (const cap of ['oracle_publish', 'cross_chain']) {
        for (const pk of S.pubkeys) {
            await allHubs(
                'INSERT IGNORE INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) ' +
                'VALUES (?, ?, ?, ?, ?)',
                [S.snapshotBlock, cap, pk, '1', pk]);
        }
    }
}

// PROVE, at boot, that the two resolvers the publish path depends on answer, on
// one hub. Returns the signing-set sources it saw.
async function assertHubResolvers(i){
    const sap = S.mvh.hubs[i].stateAnchorPublisher;
    // (0) The network field itself, because it gates BOTH halves of the pinned
    // resolver: it decides weighted-vs-count (and only the WEIGHTED accessor is
    // the one seedWeightSnapshot patches), and the local-table fallback is
    // `if(this.network === 'regtest' && this.db)`. A wrong value here makes the
    // seed above inert and produces the exact "snapshot unavailable AND no local
    // rows" line the third drive hit, so name it rather than leave it inferred.
    assert.strictEqual(String(sap.network), 'regtest',
        'hub' + i + ': the publisher\'s network is regtest (got "' + sap.network + '"); ' +
        'off regtest the weighted accessor and the local capability_snapshots fallback are both bypassed');
    assert.strictEqual(String(S.mvh.hubs[i].network), 'regtest',
        'hub' + i + ': the hub\'s network is regtest (got "' + S.mvh.hubs[i].network + '")');
    // (1) The PINNED election set: the exact call publishPendingCheckpoints makes
    // before it will elect a bundle publisher at all.
    const eligible = await sap.getActiveOraclePublishPubkeys(S.snapshotBlock);
    assert.deepStrictEqual([...eligible].sort(), [...S.pubkeys].sort(),
        'hub' + i + ': the PINNED oracle_publish election resolves to the whole federation at block ' +
        S.snapshotBlock + ' (got ' + JSON.stringify(eligible) + '). An unresolved set makes the publisher ' +
        'abstain from the bundle election, and no v0 ever reaches the chain.');
    // (2) The SIGNING set the attestation rounds tally, with the distinct
    // non-blank sources the weighted quorum needs.
    const signingSet = await sap.resolveCapabilitySet('oracle_publish', S.snapshotBlock, 'regtest');
    const sources    = signingSet.map(v => String(v.source));
    assert.strictEqual(signingSet.length, N,
        'hub' + i + ': the signing set resolves to all ' + N + ' validators (got ' + signingSet.length + ')');
    assert.strictEqual(new Set(sources).size, N,
        'hub' + i + ': every validator carries a DISTINCT source (got ' + JSON.stringify(sources) + ')');
    assert.ok(!sources.some(s => s === ''),
        'hub' + i + ': no source is blank, which WI-1\'s stake tally fails closed on (got ' +
        JSON.stringify(sources) + ')');
    return sources;
}

// Rerunnability on a dirty regtest chain: seed both hubs' counters past whatever
// earlier runs anchored. Returns the baseline batch seq (or null).
async function seedBatchBaseline(){
    // Rerunnability on a dirty regtest chain: the indexer's replay guards reject a
    // seq at-or-below the on-chain max while these hub DBs restart their counters
    // at 0. Seed both hubs' counters past whatever earlier runs anchored. The
    // baseline row is IDENTICAL on every hub (which is what keeps getNextBatchSeq
    // equal at boot) and carries a batch_seq already, so no archive selector picks
    // it up.
    const prior = await indexerQuery(
        'SELECT MAX(match_batch_seq) AS max_batch FROM anchor_actions WHERE version IN (1, 6)');
    const maxBatch = (prior.length && prior[0].max_batch != null) ? Number(prior[0].max_batch) : null;
    if (maxBatch !== null) {
        await allHubs(
            `INSERT IGNORE INTO cross_chain_matches
                (match_id, snapshot_block, network, a_chain, a_action_index, a_tick, a_amount, a_payout_addr,
                 b_chain, b_action_index, b_tick, b_amount, b_payout_addr, effective_time,
                 validator_signatures, status, batch_seq, archived_status)
             VALUES ('degarc-seq-baseline', ?, 'regtest', 'DOGE', 0, 'X', '0', 'x', 'LTC', 0, 'X', '0', 'x', 0,
                     '[]', 'finalized', ?, 'finalized')`,
            [S.snapshotBlock, maxBatch]);
    }
    return maxBatch;
}

// Equal tables are the precondition every election below rests on.
async function assertEqualBatchSeqs(){
    // Equal tables are the precondition every election below rests on. Prove it
    // at boot rather than discovering a mismatch as a stalled round later.
    const seqs = [];
    for (let i = 0; i < N; i++) seqs.push(Number(await S.mvh.hubs[i].stateAnchorPublisher.getNextBatchSeq()));
    assert.strictEqual(new Set(seqs).size, 1,
        'a fresh federation starts with every hub on the same next batch seq (got ' + JSON.stringify(seqs) + ')');
    return seqs;
}

async function bootFederation(label){
    await startHubs();
    for (let i = 0; i < N; i++) wireHub(i);
    await seedIndexerCapabilities();
    await seedHubCapabilities();
    let resolvedSources = null;
    for (let i = 0; i < N; i++) resolvedSources = await assertHubResolvers(i);

    // Both rounds this suite drives are broadcast-then-wait, so an unpeered pair
    // times out in a way indistinguishable from an unresolved capability set.
    // Counted with the SAME gate PeerManager.broadcast applies.
    const peers = await waitForPeering(60000);
    assert.ok(peers.every(c => c >= N - 1),
        'every hub can deliver a broadcast to the rest of the federation (open peers per hub: ' +
        JSON.stringify(peers) + '); an unpeered pair collects no co-signature and every round degrades');

    const maxBatch = await seedBatchBaseline();
    const seqs = await assertEqualBatchSeqs();

    // The resolved sources are logged, not just asserted: they say WHICH source
    // answered (seedWeightSnapshot's stub hands back src0/src1, the local-table
    // fallback hands back the validator pubkeys), which is the first thing worth
    // knowing if a future drive resolves an unexpected set.
    console.log('    [' + label + '] federation ' + S.federationCount + ' up: ' + N + ' hubs, snapshot_block ' +
                S.snapshotBlock + ', batch baseline ' + maxBatch + ', next batch seq ' + seqs[0] +
                ', peers/hub ' + JSON.stringify(peers) +
                ', oracle_publish sources ' + JSON.stringify(resolvedSources.map(s => String(s).slice(0, 12))) +
                ', archive round timeout ' + ROUND_TIMEOUT_MS + 'ms');
}

async function stopFederation(){
    // A fault outliving its federation would mute a hub for whatever comes next.
    if (S.fault) { try { S.fault(); } catch (e) { console.warn('    fault restore failed: ' + (e && e.message)); } S.fault = null; }
    if (S.weightSeed) { S.weightSeed.restore(); S.weightSeed = null; }
    if (S.mvh) { await S.mvh.stop(); await S.mvh.dropDatabases(); S.mvh = null; }
}

module.exports = { bootFederation, stopFederation };
