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
const { S } = require('./state');
const { waitForIndexedAnchor, waitForRewardRecord, rewardRecordsAnywhere } = require('./waits');
const { bootFederation } = require('./federation');
const { runCycle } = require('./cycle');

// The baseline cycle, really degraded, in a federation of its own.
async function runBaseline(){
    // Recovery is inherently two cycles in ONE federation, so this is the only
    // test that cannot be reduced to a first cycle. Both cycles are ARCHIVE-ONLY
    // and flush only the elected leader, so exactly one hub ever publishes and
    // the batch_seq back-fill has the cleanest run it can get. If cycle 2 still
    // finds the hubs split, runCycle fails with both views: that is the honest
    // outcome, not something to assert around.
    await bootFederation('AT-F4');

    const degraded = await runCycle('degraded (recovery baseline)', {
        requireBundle: false,
        onElected: (election) => {
            S.fault = silenceArchiveAttestor(S.mvh.hubs[election.follower]);
            console.log('    silencing hub' + election.follower + ' (co-signer for batch ' +
                        election.batchSeq + ') on the archive attestation only');
        }
    });
    assert.strictEqual(degraded.head.attest_sig_count, 0,
        'the baseline cycle really did degrade (ATTEST_SIG_COUNT ' + degraded.head.attest_sig_count + ')');
    return degraded;
}

// The co-signer returns, and the next archive batch is driven.
async function runRecovery(degraded){
    // The co-signer returns.
    S.fault();
    S.fault = null;
    console.log('    co-signer restored; driving the next archive batch');

    const recovered = await runCycle('recovered', { requireBundle: false });
    assert.ok(recovered.head.attest_sig_count >= 1,
        'the recovered batch carries an attestation tail again (ATTEST_SIG_COUNT ' +
        recovered.head.attest_sig_count + ')');
    assert.notStrictEqual(recovered.election.batchSeq, degraded.election.batchSeq,
        'the recovery batch is a NEW batch, not a retry of the degraded one');
    return recovered;
}

// The recovered batch carries its tail, indexes valid and derives its reward.
async function assertRecovered(degraded, recovered){
    const v1Row = await waitForIndexedAnchor(1, recovered.cp.ledger_hash, 180000);
    assert.ok(v1Row, 'the indexer parsed and stored the recovered v1 archive head');
    assert.strictEqual(String(v1Row.status), 'valid');
    assert.ok(v1Row.publisher_attestations && JSON.parse(String(v1Row.publisher_attestations)).length >= 1,
        'the recovered head stores its attestation tail');

    const reward = await waitForRewardRecord(recovered.election.leader, recovered.election.batchSeq, 240000);
    assert.ok(reward, 'an anchor_archive reward record derived for the recovered batch ' + recovered.election.batchSeq);
    assert.strictEqual(String(reward.doge_anchor_txid).toLowerCase(), String(recovered.headWire.txid).toLowerCase(),
        'the recovered reward is bound to the recovered head');

    // The degraded batch stays unrewarded for good: recovery mints the NEXT
    // batch's reward, it does not back-fill the one the federation withheld.
    assert.deepStrictEqual(await rewardRecordsAnywhere(degraded.election.batchSeq), [],
        'the degraded batch is still unrewarded after recovery');
}

function register(){
    it('AT-F4: the co-signer returns and the NEXT archive batch carries a tail again and derives its reward', async function () {
        const degraded = await runBaseline();
        const recovered = await runRecovery(degraded);
        await assertRecovered(degraded, recovered);
    console.log('    AT-F4: batch ' + recovered.election.batchSeq + ' ATTEST_SIG_COUNT ' +
                recovered.head.attest_sig_count + ', reward bound to ' + recovered.headWire.txid +
                '; batch ' + degraded.election.batchSeq + ' remains unrewarded');
    });
}

module.exports = { register };
