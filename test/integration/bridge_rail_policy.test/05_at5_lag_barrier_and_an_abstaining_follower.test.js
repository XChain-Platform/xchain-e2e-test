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
 * Policy AT5 (lag and barrier): with the hub poll paused, a v3 lock of a policy-bearing token
 * finalizes but the DOGE in-leg carries forward until seq 1 lands, then both apply in the same
 * block in the pinned order; a follower whose origin indexer is unreachable abstains and the
 * round finalizes on the next cycle; the measured lag is recorded (AT2 records it).
 *
 * THE PAUSE IS AT THE DESTINATION'S EDGE. The hub has no separate policy poll to pause: a
 * token's first snapshot is signed in the same engine cycle that sees its first lock (spec
 * section 3 step 2). What the barrier claim is about is the DESTINATION not yet holding a
 * snapshot while it holds the finalized transfer, so the leg withholds `policy_snapshots` at
 * the DOGE indexer's own mirror proxy (every other table keeps flowing), holds the transfer
 * past its effective_time, then releases the table.
 *
 * THE ABSTAIN LEVER is one hub's own origin indexer. Each venue hub reads its OWN BTC
 * indexer; `setHubOriginIndexer` points one follower at a port nothing listens on. At the
 * minimum quorum every signature is load-bearing, so an issuer edit cannot finalize while
 * that follower abstains, and must finalize once it reads again.
 *
 ********************************************************************/

'use strict';

const {
    POLICY_LIST_EDIT,
    listEditWire,
} = require('../../helpers/bridgeRailVenue');
const {
    assert,
    lockWireV3,
    state,
    btcAction,
    fundDoge,
    listedToken,
    hubPolicyRows,
    waitForFinalizedSeq,
    waitForAppliedSeq,
    appliedLedger,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'policy AT5: the lag barrier and an abstaining follower';
const TABLE = 'policy_snapshots';

// The finalized transfer of the lag token's lock, and its settlement on DOGE if any.
async function lagTransfer(L) {
    const rows = await state.venue.queryHubDb(state.venue.hubs[0].dbName,
        "SELECT transfer_id, effective_time FROM bridge_transfers WHERE tick = ? AND dest_address = ? AND status = 'finalized'",
        [L.tick, L.dest.address]);
    if (!rows.length) return null;
    const settled = await state.venue.queryIndexerDb('DOGE',
        "SELECT block_index, action_index FROM bridge_settlements WHERE kind = 'transfer' AND transfer_id = ?", [rows[0].transfer_id]);
    return { transferId: String(rows[0].transfer_id), effectiveTime: Number(rows[0].effective_time), settled: settled[0] || null };
}

bridgeRailSuite(GROUP, function () {
    it('policy AT5 (barrier): with seq 1 withheld from DOGE, the finalized in-leg carries forward past its effective_time', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT5 barrier')) return;
        const L = state.policy.lag;
        L.blocked = await fundDoge('POLICY.AT5.BLOCKED', 1);
        L.dest = await fundDoge('POLICY.AT5.DEST', 2);
        Object.assign(L, await listedToken('AT5LAG', ['LAGA', 'LAGB', 'LAGC'], [L.blocked.address]));
        assert.strictEqual(L.optIn.status, 'valid', 'ISSUE|7 of the lag token graded ' + L.optIn.status);
        state.venue.dogeVenue.withholdMirrorTable(0, TABLE);
        L.withheld = true;
        const lock = await btcAction(L.issuer, lockWireV3(L.tick, 'DOGE', L.dest.address, 1, 'policy AT5 lag'), 'xbridges');
        assert.strictEqual(lock.status, 'valid', 'the lag token lock graded ' + lock.status);
        let reading = null;
        await state.venue.waitUntil('the lag lock to finalize on the hub', async () => { reading = await lagTransfer(L); return !!reading; },
            { timeoutMs: 30 * 60 * 1000, everyMs: 5000 });
        L.seq1 = await waitForFinalizedSeq(L.tick, 1);
        await state.venue.waitUntil('the lag transfer\'s effective_time to pass', () => Date.now() / 1000 >= reading.effectiveTime + 5,
            { timeoutMs: 60 * 60 * 1000, everyMs: 5000 });
        const tip = Number((await state.venue.venueTips()).DOGE);
        await state.venue.waitForVenueTip('DOGE', tip + 3, 'past the lag transfer\'s effective_time', { timeoutMs: 15 * 60 * 1000, everyMs: 5000 });
        reading = await lagTransfer(L);
        state.evidence.at5_barrier = { tick: L.tick, transfer: reading, seq1: String(L.seq1.snapshot_id) };
        assert.strictEqual(reading.settled, null, 'DOGE applied the in-leg of a policy-bearing token at block ' +
            (reading.settled && reading.settled.block_index) + ' while it held no policy snapshot for it');
    });
});

bridgeRailSuite(GROUP, function () {
    it('policy AT5 (release): once seq 1 reaches DOGE, the snapshot and the in-leg apply in the same block, the snapshot first', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT5 release')) return;
        const L = state.policy.lag;
        assert.ok(L.withheld, 'the barrier half must have run');
        state.venue.dogeVenue.releaseMirrorTable(0, TABLE);
        L.withheld = false;
        const policy = await waitForAppliedSeq(L.tick, 1);
        let reading = null;
        await state.venue.waitUntil('the lag in-leg to apply on DOGE', async () => { reading = await lagTransfer(L); return !!(reading && reading.settled); },
            { timeoutMs: 20 * 60 * 1000, everyMs: 5000 });
        state.evidence.at5_release = { policy, transfer: reading };
        assert.strictEqual(Number(reading.settled.block_index), policy.block,
            'the in-leg applied at DOGE block ' + reading.settled.block_index + ' and seq 1 at ' + policy.block);
        assert.ok(policy.actionIndex < Number(reading.settled.action_index),
            'seq 1 (action ' + policy.actionIndex + ') did not apply before the in-leg (action ' + reading.settled.action_index + ')');
    });

    after(function () {
        // Never leave the DOGE indexer blind to policy rows for the legs after this one.
        const L = state.policy.lag;
        if (L.withheld && state.venue && state.venue.dogeVenue) state.venue.dogeVenue.releaseMirrorTable(0, TABLE);
    });
});

bridgeRailSuite(GROUP, function () {
    it('policy AT5 (abstain): an edit does not finalize while one follower\'s origin indexer is unreachable, and finalizes on the next cycle once it reads again', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT5 abstain')) return;
        const L = state.policy.lag;
        assert.ok(L.seq1, 'the barrier half must have run');
        const follower = state.venue.hubs.length - 1;
        L.newMember = await fundDoge('POLICY.AT5.MEMBER', 1);
        await state.venue.setHubOriginIndexer(follower, 'http://127.0.0.1:1');
        let during = null;
        try {
            const edit = await btcAction(L.issuer, listEditWire(POLICY_LIST_EDIT.ADD, L.listIndex, [L.newMember.address], 'policy AT5 abstain'), 'lists');
            assert.strictEqual(edit.status, 'valid', 'the issuer edit graded ' + edit.status);
            // Three engine poll cycles past the edit's confirmation: a quorum that did not need
            // this follower would have finalized in the first.
            const cycles = 3 * Number(state.venue.pollMs || 15000);
            const since = Date.now();
            await state.venue.waitUntil('three poll cycles with the follower abstaining', () => Date.now() - since >= cycles,
                { timeoutMs: cycles + 60000, everyMs: 5000 });
            during = (await hubPolicyRows(L.tick)).filter((r) => Number(r.policy_seq) >= 2 && String(r.status) === 'finalized');
        } finally {
            await state.venue.setHubOriginIndexer(follower, null);
        }
        const restoredAt = Date.now();
        const seq2 = await waitForFinalizedSeq(L.tick, 2);
        state.evidence.at5_abstain = { follower, finalizedWhileAbstaining: during.map((r) => String(r.snapshot_id)),
            seq2: String(seq2.snapshot_id), secondsAfterRestore: Math.round((Date.now() - restoredAt) / 1000),
            ledger: await appliedLedger(L.tick) };
        assert.deepStrictEqual(during, [], 'seq 2 finalized while hub ' + follower + ' could not read its origin indexer');
        assert.strictEqual(Number(seq2.policy_seq), 2, 'the edit finalized as seq ' + seq2.policy_seq);
    });
});
