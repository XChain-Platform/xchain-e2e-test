/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const { S, N, sleep } = require('./state');

// The v1 archive-head tail, off the bytes that went to the chain.
// anchorVersionHelper parses the v0 BUNDLE wire only, and adding a v1 parser to
// that shared helper is another row's surface, so the walk lives here:
//   ANCHOR|1|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH
//         |CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK|MATCH_BATCH_SEQ
//         |MATCH_COUNT|CRC|TOTAL_CHUNKS|CHUNK0|SIG_COUNT|PUBKEY|SIG|...
//         |PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|...
// (StateAnchorPublisher.publishArchive builds it; xchain-indexer anchor/index.js
// formats[1] reads it back at the same offsets.)
function parseArchiveHead(payload){
    const f = String(payload).split('|');
    if (f[0] !== 'ANCHOR' || f[1] !== '1') return null;
    const SIG_COUNT_INDEX = 16;
    const sigCount = Number(f[SIG_COUNT_INDEX]);
    if (!Number.isInteger(sigCount) || sigCount < 0)
        throw new Error('ANCHOR v1 has a non-numeric SIG_COUNT');
    const tail = SIG_COUNT_INDEX + 1 + (2 * sigCount);
    if (tail + 1 >= f.length) throw new Error('ANCHOR v1 carries no publisher tail');
    const attestCount = Number(f[tail + 1]);
    if (!Number.isInteger(attestCount) || attestCount < 0)
        throw new Error('ANCHOR v1 has a non-numeric ATTEST_SIG_COUNT');
    return {
        chain: f[2], network: f[3], block_index: Number(f[4]),
        ledger_hash: f[6], checkpoint_seq: Number(f[9]), snapshot_block: Number(f[10]),
        batch_seq: Number(f[11]), sig_count: sigCount,
        publisher: String(f[tail]).toLowerCase(), attest_sig_count: attestCount
    };
}

// ONE hub's view of the archive election, assembled from the SAME reads
// startArchiveRound makes on that hub: its own BTC tip, its own wrapper
// checkpoint (the BTC-preferred latest row on the consensus key), its own next
// batch seq, its own oracle_publish election set, its own key method. Nothing
// here is taken from a peer or from the harness's identity list, because reading
// one hub and flushing another is exactly how the first live drive lost a cycle.
async function archiveElectionView(i){
    const hub = S.mvh.hubs[i];
    const sap = hub.stateAnchorPublisher;
    const electionBlock = await hub.resolveBtcLatestBlock();
    const cpRow = (await hub.db.doQuery(
        "SELECT * FROM state_checkpoints WHERE network = ? " +
        "ORDER BY (chain = 'BTC') DESC, checkpoint_seq DESC, snapshot_block DESC, block_index DESC LIMIT 1",
        ['regtest']))[0];
    const batchSeq = Number(await sap.getNextBatchSeq());
    const key      = sap.archiveElectionKey(
        { chain: cpRow.chain, network: cpRow.network, checkpoint_seq: cpRow.checkpoint_seq }, batchSeq);
    const order    = S.SAP.hashOrder(key, await sap.getActiveOraclePublishPubkeys(electionBlock));
    return {
        hub: i, electionBlock, cpRow, batchSeq, key, order,
        leader: S.pubkeys.indexOf(order[0]),
        // The hub's OWN verdict on itself, through the predicate startArchiveRound
        // consults. A rank the test computed and a rank the hub computed disagreeing
        // is precisely the bug this function exists to catch.
        selfRankZero: sap.isRankZero(order)
    };
}

// The archive election, agreed by the WHOLE federation.
//
// On a federation's FIRST cycle this is settled by construction (bootFederation
// asserts the seqs are equal), and the poll returns immediately. It still polls
// because AT-F4's second cycle depends on the XANC_FINALIZED back-fill of
// batch_seq reaching the non-publishing hub, and that is a real, bounded wait.
// What it must never do is paper over a SPLIT: if the hubs have genuinely
// diverged (each having published its own batch), no amount of waiting converges
// them, so the budget expires and the result carries every hub's view for the
// assertion message.
async function electArchive(timeMax = 120000){
    const deadline = Date.now() + timeMax;
    let views = [];
    while (Date.now() < deadline) {
        views = [];
        for (let i = 0; i < N; i++) views.push(await archiveElectionView(i));
        const agreedKey    = new Set(views.map(v => v.key)).size === 1;
        const agreedLeader = new Set(views.map(v => v.leader)).size === 1;
        const leader       = views[0].leader;
        if (agreedKey && agreedLeader && leader >= 0 && views[leader].selfRankZero) {
            return {
                converged: true, views,
                cpRow:    views[leader].cpRow,
                batchSeq: views[leader].batchSeq,
                key:      views[leader].key,
                leader:   leader,
                // N = 2, so the non-leader IS the co-signer whose
                // _handleArchiveAttestSignReq AT-F3 mutes. Silencing the leader would
                // be a no-op by construction: the leader broadcasts the request and
                // waits, it never answers one.
                follower: S.pubkeys.indexOf(views[leader].order[views[leader].order.length - 1])
            };
        }
        await sleep(1000);
    }
    return { converged: false, views };
}

// Every hub's election view, one line each, for an assertion message.
function describeViews(views){
    return (views || []).map(v =>
        'hub' + v.hub + ' batch ' + v.batchSeq + ' key ' + v.key +
        ' leader hub' + v.leader + (v.selfRankZero ? ' (self rank 0)' : ' (self rank ' + v.order.indexOf(S.pubkeys[v.hub]) + ')')
    ).join(' | ');
}

// The bundle election is keyed on network + snapshot_block only (the bundle's
// block is the MAX over its sections, and every section of a federation sits at
// its one snapshot block). Built through the publisher's OWN key method rather
// than a copy of the string: that tag is an opaque domain separator whose
// spelling deliberately did not move with the wire version, and a drifting copy
// here would silently elect the wrong hub.
function electBundle(){
    const key = S.mvh.hubs[0].stateAnchorPublisher.bundleElectionKey(
        { network: 'regtest', snapshot_block: S.snapshotBlock });
    return S.pubkeys.indexOf(S.SAP.hashOrder(key, S.pubkeys)[0]);
}

module.exports = { parseArchiveHead, electArchive, describeViews, electBundle };
