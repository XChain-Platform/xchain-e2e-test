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

const { S } = require('./state');
const { waitForIndexedAnchor, waitForRewardRecord } = require('./waits');
const { bootFederation } = require('./federation');
const { runCycle } = require('./cycle');

// AT-F2: the signing set the round resolves, and the broadcast the co-signer saw.
// Returns the distinct sources for the closing log line.
async function assertSigningSet(c1){
    const leaderSap = S.mvh.hubs[c1.election.leader].stateAnchorPublisher;

    // AT-F2, first clause: the set the round resolves at the wrapper's
    // snapshot_block, read through the publisher's OWN resolver. >= 2 DISTINCT
    // SOURCES containing the publisher is what makes snapCount <= 1's
    // self-satisfying short-circuit unreachable.
    const signingSet = await leaderSap.resolveCapabilitySet('oracle_publish', S.snapshotBlock, 'regtest');
    const sources    = new Set(signingSet.map(v => String(v.source)));
    assert.ok(signingSet.length >= 2,
        'the oracle_publish set holds >= 2 members (got ' + signingSet.length + ')');
    assert.ok(sources.size >= 2,
        'the set holds >= 2 DISTINCT SOURCES, so the stake tally cannot be met by the publisher alone (got ' +
        JSON.stringify([...sources]) + ')');
    assert.ok(signingSet.some(v => v.pubkey === S.pubkeys[c1.election.leader]),
        'the publisher is itself in the set (otherwise the round abstains before broadcasting)');

    // AT-F2, second clause and the positive one: the round BROADCAST. Counted on
    // the co-signer's own message path, so this is evidence of the wire, not an
    // inference from the set size.
    assert.ok(c1.signReqDelta[c1.election.follower] >= 1,
        'the co-signer observed an XANCARCHPUB_SIGN_REQ this cycle (deltas ' +
        JSON.stringify(c1.signReqDelta) + '); without it the publisher took the short-circuit');
    return sources;
}

// AT-F1: the attested v1 head, on the wire and as the indexer stored it.
async function assertAttestedHead(c1){
    // AT-F1: the attested v1 head, on the wire and as the indexer stored it.
    assert.ok(c1.head.attest_sig_count >= 1,
        'the v1 head carries an attestation tail (ATTEST_SIG_COUNT ' + c1.head.attest_sig_count + ')');
    const v1Row = await waitForIndexedAnchor(1, c1.cp.ledger_hash, 180000);
    assert.ok(v1Row, 'the indexer parsed and stored the v1 archive head');
    assert.strictEqual(String(v1Row.status), 'valid',
        'the v1 head verified against the mirrored oracle_publish set (got ' + v1Row.status + ')');
    assert.strictEqual(Number(v1Row.match_batch_seq), c1.election.batchSeq);
    assert.ok(v1Row.publisher_attestations && JSON.parse(String(v1Row.publisher_attestations)).length >= 1,
        'the stored tail carries the attestation signatures');
}

// AT-F1: the v0 bundle of the same cycle.
async function assertAttestedBundle(c1){
    // AT-F1: the v0 bundle of the same cycle.
    assert.ok(c1.bundle.bundle.attest_sig_count >= 1,
        'the v0 bundle carries its own attestation tail (ATTEST_SIG_COUNT ' +
        c1.bundle.bundle.attest_sig_count + ')');
    const v0Row = await waitForIndexedAnchor(0, c1.cp.ledger_hash, 180000);
    assert.ok(v0Row, 'the indexer parsed and stored the v0 bundle section');
    assert.strictEqual(String(v0Row.status), 'valid',
        'the v0 bundle section is valid (got ' + v0Row.status + ')');
}

// AT-F1: the reward.
async function assertAttestedReward(c1){
    // AT-F1: the reward. ANCHOR_REWARD_DERIVE_ACTIVATION.regtest is 0, so this is
    // the anchor_reward_attestations row the BTC indexer derives validator_rewards
    // from, written only after the round met quorum AND the head was proven mined.
    const reward = await waitForRewardRecord(c1.election.leader, c1.election.batchSeq, 240000);
    assert.ok(reward, 'an anchor_archive reward record derived for batch ' + c1.election.batchSeq);
    assert.strictEqual(String(reward.publisher).toLowerCase(), S.pubkeys[c1.election.leader],
        'the reward names the elected publisher');
    assert.strictEqual(String(reward.doge_anchor_txid).toLowerCase(), String(c1.headWire.txid).toLowerCase(),
        'the reward is bound to the archive head that actually mined');
    assert.ok(JSON.parse(String(reward.publisher_attestations)).length >= 1,
        'the reward record carries the XANCPUB quorum it was earned with');
}

function register(){
    it('AT-F1/AT-F2: both hubs answering, the archive round really broadcasts and the attested v1 derives its reward', async function () {
        await bootFederation('AT-F1/F2');
        const c1 = await runCycle('attested');
        const sources = await assertSigningSet(c1);
        await assertAttestedHead(c1);
        await assertAttestedBundle(c1);
        await assertAttestedReward(c1);
    console.log('    AT-F1: v1 ' + c1.headWire.txid + ' ATTEST_SIG_COUNT ' + c1.head.attest_sig_count +
                ', reward round_reference ' + c1.election.batchSeq +
                '; AT-F2: ' + sources.size + ' distinct sources, ' +
                c1.signReqDelta[c1.election.follower] + ' SIGN_REQ observed by the co-signer');
    });
}

module.exports = { register };
