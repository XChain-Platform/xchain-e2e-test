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
 **********************************************************************
 *
 * Policy AT2: the issuer LIST edits the origin block list (one add, one remove); within one
 * cycle plus effective_time DOGE holds seq 2, getappliedpolicy on DOGE and gettokenpolicy on
 * BTC agree on membership and hash, and the verdicts flip accordingly.
 *
 * ONE SNAPSHOT FOR TWO EDITS. The add and the remove are mined into ONE BTC block, so the
 * hub reads their combined effect at one origin height and the claim "DOGE holds seq 2" is
 * about one snapshot rather than a race between two poll cycles.
 *
 * The origin-edit-to-destination-apply lag is MEASURED here, in wall seconds and in DOGE
 * blocks, for the spec's "measured on the rail and printed on the token page".
 *
 ********************************************************************/

'use strict';

const {
    POLICY_LIST_EDIT,
    listEditWire,
} = require('../../helpers/bridgeRailVenue');
const {
    assert,
    state,
    fundDoge,
    oneBtcBlock,
    originPolicy,
    copyPolicy,
    appliedPolicyRead,
    waitForFinalizedSeq,
    waitForAppliedSeq,
    sendCopy,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'policy AT2: an issuer edit reaches the copy';

bridgeRailSuite(GROUP, function () {
    it('policy AT2 (edit): one add and one remove on the origin block list, in one BTC block, finalize as seq 2 and DOGE applies it', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT2 edit')) return;
        const M = state.policy.main;
        assert.ok(state.evidence.at1_sends, 'AT1 must have run');
        M.blocked2 = await fundDoge('POLICY.AT2.BLOCKED', 1);
        const startedMs = Date.now();
        const dogeTipAtEdit = Number((await state.venue.venueTips()).DOGE);
        const edits = await oneBtcBlock(M.issuer, [
            listEditWire(POLICY_LIST_EDIT.ADD, M.listIndex, [M.blocked2.address], 'policy AT2 add'),
            listEditWire(POLICY_LIST_EDIT.REMOVE, M.listIndex, [M.blocked.address], 'policy AT2 remove'),
        ], 'lists');
        for (const e of edits) assert.strictEqual(e.status, 'valid', 'an issuer LIST edit graded ' + e.status);
        const seq2 = await waitForFinalizedSeq(M.tick, 2);
        assert.strictEqual(Number(seq2.policy_seq), 2, 'the edit finalized as seq ' + seq2.policy_seq + ', not 2');
        const applied = await waitForAppliedSeq(M.tick, 2);
        state.evidence.at2_lag = { wallSeconds: Math.round((Date.now() - startedMs) / 1000),
            dogeBlocks: Number(applied.block) - dogeTipAtEdit, seq2: String(seq2.snapshot_id),
            effectiveTime: Number(seq2.effective_time), appliedBlock: applied.block };
        console.log('  policy AT2 measured lag: ' + JSON.stringify(state.evidence.at2_lag));
        M.seq2 = seq2;
        assert.strictEqual(applied.snapshotId, String(seq2.snapshot_id), 'DOGE applied ' + applied.snapshotId + ' as seq 2');
    });
});

bridgeRailSuite(GROUP, function () {
    it('policy AT2 (reads): getappliedpolicy on DOGE and gettokenpolicy on BTC agree on membership and hash', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT2 reads')) return;
        const M = state.policy.main;
        assert.ok(M.seq2, 'the edit half must have run');
        const origin = await originPolicy(M.tick, Number(M.seq2.origin_block));
        const copy = await copyPolicy(M.tick);
        const applied = await appliedPolicyRead(M.tick);
        state.evidence.at2_reads = { origin, copy, applied };
        assert.deepStrictEqual(origin.block_list, [M.blocked2.address], 'the origin block list reads ' + JSON.stringify(origin.block_list));
        assert.deepStrictEqual(copy.block_list, origin.block_list, 'the copy\'s materialized block list differs from the origin');
        assert.strictEqual(copy.policy_hash, origin.policy_hash, 'the copy\'s policy hash differs from the origin');
        assert.ok(!applied.error, 'getappliedpolicy on DOGE answered ' + JSON.stringify(applied));
        assert.strictEqual(Number(applied.policy_seq), 2, 'getappliedpolicy on DOGE reads seq ' + applied.policy_seq);
        assert.strictEqual(String(applied.policy_hash), String(origin.policy_hash),
            'getappliedpolicy on DOGE reads hash ' + applied.policy_hash + ', the origin ' + origin.policy_hash);
    });
});

bridgeRailSuite(GROUP, function () {
    it('policy AT2 (verdicts flip): a SEND to the newly blocked address is refused and a SEND to the removed one applies', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT2 verdicts')) return;
        const M = state.policy.main;
        assert.ok(M.seq2, 'the edit half must have run');
        const nowBlocked = await sendCopy(M.dest, M.tick, 1, M.blocked2.address, 'policy AT2 blocked');
        const nowAllowed = await sendCopy(M.dest, M.tick, 1, M.blocked.address, 'policy AT2 unblocked');
        state.evidence.at2_sends = { nowBlocked, nowAllowed };
        assert.strictEqual(nowBlocked.status, 'invalid: DESTINATION (not authorized)', 'a SEND to the added address graded ' + nowBlocked.status);
        assert.strictEqual(nowAllowed.status, 'valid', 'a SEND to the removed address graded ' + nowAllowed.status);
    });
});
