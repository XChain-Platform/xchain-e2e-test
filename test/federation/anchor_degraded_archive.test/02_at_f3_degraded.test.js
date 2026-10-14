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

const { silenceArchiveAttestor } = require('../../helpers/byzantineFaults');
const { S } = require('./support/state');
const { waitForIndexedAnchor, waitForRewardRecord, rewardRecordsAnywhere } = require('./support/waits');
const { bootFederation } = require('./support/federation');
const { runCycle } = require('./support/cycle');

// Its own federation and the degraded cycle, with the co-signer silenced from
// inside the cycle on its own agreed election.
async function runDegradedCycle(){
    // Its OWN federation, so this is the FIRST archive round these hubs ever run:
    // equal tables, one well-defined election, nothing inherited from an earlier
    // cycle. The fault goes in before that first round, which is what makes the
    // degraded path the only path this test can be measuring.
    await bootFederation('AT-F3');

    // Silenced from inside the cycle, on its own agreed election: the key binds
    // the wrapper checkpoint AND the batch seq, so the co-signer can only be named
    // once both are known. It must be the CO-SIGNER, never the leader: the leader
    // broadcasts XANCARCHPUB_SIGN_REQ and waits for answers, so muting its own
    // handler would change nothing and the round would meet quorum as in AT-F1.
    let silenced = null;
    const c2 = await runCycle('degraded', {
        onElected: (election) => {
            assert.notStrictEqual(election.follower, election.leader,
                'the fault targets the CO-SIGNER; silencing the elected leader is a no-op by construction');
            silenced = election.follower;
            S.fault = silenceArchiveAttestor(S.mvh.hubs[election.follower]);
            console.log('    silencing hub' + election.follower + ' (co-signer for batch ' +
                        election.batchSeq + ', leader is hub' + election.leader + ') on the archive attestation only');
        }
    });
    assert.strictEqual(c2.election.follower, silenced,
        'the hub that was silenced is this cycle\'s co-signer');
    assert.notStrictEqual(silenced, c2.election.leader,
        'the elected publisher was left answering; only its co-signer went quiet');
    return c2;
}

// The degraded shape: the head still lands, with no tail.
async function assertDegradedHead(c2){
    // The degraded shape: the head still lands, with no tail.
    assert.strictEqual(c2.head.attest_sig_count, 0,
        'the archive attestation round did not meet quorum, so the tail is empty');
    assert.ok(c2.head.sig_count >= 2,
        'the WRAPPER co-sign quorum was untouched by the fault (' + c2.head.sig_count + ' signatures)');
    const v1Row = await waitForIndexedAnchor(1, c2.cp.ledger_hash, 180000);
    assert.ok(v1Row, 'the indexer parsed and stored the degraded v1 archive head');
    assert.strictEqual(String(v1Row.status), 'valid',
        'a degraded attestation costs the reward, never the checkpoint (got ' + v1Row.status + ')');
    assert.strictEqual(v1Row.publisher_attestations, null,
        'an ATTEST_SIG_COUNT 0 tail stores NULL, carrying no signatures at all');
}

// The request reached the co-signer, and no reward derived for the batch.
async function assertNoReward(c2){
    // The request still reached the co-signer; only the ANSWER was withheld. This
    // is what separates a degraded round from a round that never ran.
    assert.ok(c2.signReqDelta[c2.election.follower] >= 1,
        'the silenced co-signer still received the XANCARCHPUB_SIGN_REQ (deltas ' +
        JSON.stringify(c2.signReqDelta) + ')');

    // No reward for this batch, on either hub, after the SAME drain that produced
    // one in AT-F1 has had its chance.
    // give-up-ok: the null IS the assertion here, and it is only meaningful
    // because the identical call returns a row on the attested path.
    const none = await waitForRewardRecord(c2.election.leader, c2.election.batchSeq, 60000);
    assert.strictEqual(none, null,
        'no anchor_archive reward record derived for the degraded batch ' + c2.election.batchSeq);
    assert.deepStrictEqual(await rewardRecordsAnywhere(c2.election.batchSeq), [],
        'no hub in the federation holds a reward record for the degraded batch');
}

// THE clause the narrow seam exists for: the v0 bundle of this same cycle is
// untouched. Returns the stored v0 row for the closing log line.
async function assertBundleIntact(c2){
    // THE clause the narrow seam exists for: the v0 bundle of this same cycle is
    // untouched. A shared-timer fault would have landed it 'invalid: ATTEST_SIG_COUNT'.
    assert.ok(c2.bundle.bundle.attest_sig_count >= 1,
        'the v0 bundle of the degraded cycle still carries its attestation tail (ATTEST_SIG_COUNT ' +
        c2.bundle.bundle.attest_sig_count + ')');
    const v0Row = await waitForIndexedAnchor(0, c2.cp.ledger_hash, 180000);
    assert.ok(v0Row, 'the indexer parsed and stored the v0 bundle section of the degraded cycle');
    assert.strictEqual(String(v0Row.status), 'valid',
        'the v0 bundle of the degraded cycle is still valid (got ' + v0Row.status + ')');
    return v0Row;
}

function register(){
    it('AT-F3: with the co-signer silenced ON THE ARCHIVE ATTESTATION ONLY, the v1 lands at ATTEST_SIG_COUNT 0, valid, unrewarded - and the SAME cycle\'s v0 bundle still carries its tail', async function () {
        const c2 = await runDegradedCycle();
        await assertDegradedHead(c2);
        await assertNoReward(c2);
        const v0Row = await assertBundleIntact(c2);
    console.log('    AT-F3: v1 ' + c2.headWire.txid + ' ATTEST_SIG_COUNT 0 valid, no reward for batch ' +
                c2.election.batchSeq + '; v0 bundle still ' + v0Row.status + ' with ' +
                c2.bundle.bundle.attest_sig_count + ' attesting sig(s)');
    });
}

module.exports = { register };
