/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const anchorVersions = require('../../../helpers/anchorVersionHelper');
const { S, N, sleep } = require('./state');
const { indexerQuery } = require('./db');

// Peers a hub could actually DELIVER a broadcast to, counted with the SAME gate
// PeerManager.broadcast applies (`peer.ws && readyState === OPEN`). Peer presence
// in the map is not enough: an entry sitting in 'connecting' receives nothing, and
// every round this suite drives is broadcast-then-wait.
function deliverablePeers(hub){
    let n = 0;
    for (const [, peer] of (hub.peerManager && hub.peerManager.peers) || [])
        if (peer.ws && peer.ws.readyState === 1) n++;      // 1 = WebSocket.OPEN
    return n;
}

// Hubs holding an archive round that has not settled: one still collecting
// signatures (_archiveRound) or one whose publish is still in flight
// (_archivePublishing). Both are the guards startArchiveRound reads on its very
// first line, `if(this._archiveRound || this._archivePublishing) return
// 'round_pending'`, so either one makes the next flush decline before it elects
// anything at all.
function busyArchiveRounds(){
    return S.mvh.hubs
        .map((h, i) => ({
            i,
            collecting: !!h.stateAnchorPublisher['_archiveRound'],
            publishing: !!h.stateAnchorPublisher['_archivePublishing']
        }))
        .filter(s => s.collecting || s.publishing);
}

// Wait for the whole federation to be free of an in-flight archive round.
//
// The two-hub round is ASYNCHRONOUS in both halves: the flush returns
// 'round_started' and the v1 publishes later when the co-signature lands, and
// even waitForArchiveHead returns while publishArchive is still running (the
// wire is recorded from inside the broadcast hook, ahead of the batch back-fill,
// the intent settle and the reward defer). So a SECOND cycle in one federation
// that flushes immediately gets 'round_pending' and measures nothing. The right
// fix is to wait for the previous round rather than to accept its verdict: a
// cycle-2 assertion satisfied by cycle 1's round is exactly the kind of green
// that measures something easier than it claims. Polled on the publisher's own
// two guards, never slept on. Returns whatever is still busy so the caller can
// name it.
async function waitForArchiveQuiescent(timeMax){
    const deadline = Date.now() + timeMax;
    let busy = busyArchiveRounds();
    while (Date.now() < deadline) {
        busy = busyArchiveRounds();
        if (busy.length === 0) return busy;
        await sleep(500);
    }
    return busy;
}

function describeBusy(busy){
    return (busy || []).map(s =>
        'hub' + s.i + (s.collecting ? ' collecting signatures' : '') + (s.publishing ? ' publishing' : '')
    ).join(', ');
}

// P2P dial-up is asynchronous after startP2P, so poll rather than sample once.
// Returns the per-hub counts either way, so the caller's assertion can name them.
async function waitForPeering(timeMax){
    const deadline = Date.now() + timeMax;
    let counts = S.mvh.hubs.map(deliverablePeers);
    while (Date.now() < deadline) {
        counts = S.mvh.hubs.map(deliverablePeers);
        if (counts.every(c => c >= N - 1)) return counts;
        await sleep(500);
    }
    return counts;
}

// Wait for the archive head of this cycle. The two-hub archive round is
// ASYNCHRONOUS: startArchiveRound returns 'round_started' and the v1 is
// published later, when the wrapper co-signature arrives - and in a degraded
// cycle only after the attestation round times out. Polls for the wire rather
// than settling for a fixed window.
async function waitForArchiveHead(sinceIndex, timeMax){
    const deadline = Date.now() + timeMax;
    while (Date.now() < deadline) {
        const head = S.broadcasts.slice(sinceIndex)
            .find(b => anchorVersions.anchorPayloadVersion(b.payload) === 1);
        if (head) return head;
        await sleep(1000);
    }
    return null;
}

// The anchor_actions row the DOGE indexer stored for one of our anchors, keyed
// on OUR ledger_hash so a prior run's anchors on this dirty chain cannot satisfy
// an assert. Mines while it waits: regtest produces no organic blocks.
async function waitForIndexedAnchor(version, ledgerHash, timeMax){
    const deadline = Date.now() + timeMax;
    while (Date.now() < deadline) {
        const rows = await indexerQuery(
            `SELECT a.*, s.status FROM anchor_actions a
             LEFT JOIN index_statuses s ON s.id = a.status_id
             WHERE a.version = ? AND a.ledger_hash = ?`, [version, ledgerHash]);
        if (rows.length) return rows[0];
        await regtestMinerConnector.generateBlocks(1);
        await sleep(2000);
    }
    return null;
}

// The archive-reward record for a batch, as this venue can observe it.
//
// ANCHOR_REWARD_DERIVE_ACTIVATION.regtest is 0, so the DOGE indexer deliberately
// writes NO validator_rewards row: derivation has relocated to the BTC indexer,
// which keys on the hub-mirrored anchor_reward_attestations row (capability stake
// is BTC-side; ANCHOR is DOGE-only). On a DOGE-only venue that row IS the reward
// derivation, and it is written only once the attestation quorum was met AND
// verifyAnchorOnChain has bound this exact txid at version 1, dogeConfirmations
// deep. Drives the real drain the flush head calls rather than reimplementing it.
async function waitForRewardRecord(hubIndex, batchSeq, timeMax){
    const deadline = Date.now() + timeMax;
    while (Date.now() < deadline) {
        await S.mvh.hubs[hubIndex].stateAnchorPublisher.drainDeferredRewardAttest();
        const rows = await S.mvh.hubs[hubIndex].db.doQuery(
            "SELECT * FROM anchor_reward_attestations " +
            "WHERE reward_type = 'anchor_archive' AND round_reference = ? AND snapshot_block = ?",
            [batchSeq, S.snapshotBlock]);
        if (rows.length) return rows[0];
        await regtestMinerConnector.generateBlocks(1);
        await sleep(2000);
    }
    return null;
}

// Every anchor_archive record for this batch across the federation (a co-signer
// can write its own copy from a federated XANCREWARD, so a leader-only read
// would miss one).
async function rewardRecordsAnywhere(batchSeq){
    const found = [];
    for (let i = 0; i < N; i++) {
        const rows = await S.mvh.hubs[i].db.doQuery(
            "SELECT publisher FROM anchor_reward_attestations " +
            "WHERE reward_type = 'anchor_archive' AND round_reference = ? AND snapshot_block = ?",
            [batchSeq, S.snapshotBlock]);
        for (const r of rows) found.push('hub' + i + ':' + String(r.publisher).slice(0, 12));
    }
    return found;
}

module.exports = { busyArchiveRounds, waitForArchiveQuiescent, describeBusy, waitForPeering, waitForArchiveHead, waitForIndexedAnchor, waitForRewardRecord, rewardRecordsAnywhere };
