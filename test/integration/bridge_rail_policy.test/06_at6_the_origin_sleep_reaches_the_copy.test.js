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
 * Policy AT6 (sleep): the issuer sleeps the token on BTC; DOGE applies a snapshot with
 * sleeping 1 and transfers of the copy are `invalid: TICK (sleeping)`; a v4 burn is refused while
 * the tick sleeps (operator ruling 2026-09-29); the issuer wakes it and the copy wakes within one cycle.
 *
 * THE WAKE is a SLEEP format 1 whose RESUME_BLOCK is the next BTC block: the sleep read treats
 * a row as asleep only at -1 or a future block (policy spec section 4, D8), so the origin reads
 * awake from that block on and the next snapshot carries sleeping 0.
 *
 ********************************************************************/

'use strict';

const { sleepTickWire } = require('../../helpers/bridgeRailVenue');
const {
    newestFinalizedSnapshot,
    nextFinalizedSnapshot,
    policyFinalizationBudgetMs,
} = require('../../helpers/rail_preflight/policy_at7_at8');
const {
    assert,
    burnWireV4,
    state,
    btcAction,
    dogeAction,
    fundBtc,
    hubPolicyRows,
    waitForAppliedSeq,
    copyPolicy,
    sendCopy,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'policy AT6: the origin sleep reaches the copy';
const WAKE_SENDS = 3;
const STALE_RESUME_BLOCK = 'invalid: RESUME_BLOCK (block_index)';

async function sendWakeAtFreshTip(M) {
    const attempts = [];
    let wake = null;
    for (let send = 0; send < WAKE_SENDS; send++) {
        const resumeBlock = Number(await nodeConnector.getBlockCount()) + 1;
        wake = await btcAction(M.issuer, sleepTickWire(M.tick, resumeBlock, 'policy AT6 wake'), 'sleeps');
        attempts.push({ tx: wake.tx, resumeBlock, status: wake.status });
        if (wake.status !== STALE_RESUME_BLOCK) break;
    }
    return { wake, attempts };
}

bridgeRailSuite(GROUP, function () {
    it('policy AT6 (sleep): the issuer sleeps the token on BTC, DOGE applies sleeping 1 and a SEND of the copy is invalid: TICK (sleeping)', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT6 sleep')) return;
        const M = state.policy.main;
        assert.ok(M.seq2, 'AT2 must have run');
        const previous = newestFinalizedSnapshot(await hubPolicyRows(M.tick), M.tick);
        assert.ok(previous, 'the sleep needs an existing finalized snapshot for ' + M.tick);
        const sleep = await btcAction(M.issuer, sleepTickWire(M.tick, -1, 'policy AT6 sleep'), 'sleeps');
        assert.strictEqual(sleep.status, 'valid', 'the issuer SLEEP of ' + M.tick + ' graded ' + sleep.status);
        await state.venue.waitUntil('a later finalized policy_snapshots row for ' + M.tick, async () => {
            M.sleepSeq = nextFinalizedSnapshot(await hubPolicyRows(M.tick), M.tick, previous);
            return !!M.sleepSeq;
        }, {
            timeoutMs: policyFinalizationBudgetMs(state.venue.pollMs || 15000),
            everyMs: 5000,
        });
        assert.strictEqual(Number(M.sleepSeq.sleeping), 1, 'seq ' + M.sleepSeq.policy_seq + ' carries sleeping ' + M.sleepSeq.sleeping);
        await waitForAppliedSeq(M.tick, Number(M.sleepSeq.policy_seq));
        const copy = await copyPolicy(M.tick);
        const send = await sendCopy(M.dest, M.tick, 1, M.other.address, 'policy AT6 asleep');
        state.evidence.at6_sleep = { sleep, seq: String(M.sleepSeq.snapshot_id), copySleeping: copy.sleeping, send };
        assert.strictEqual(copy.sleeping, true, 'the copy does not read sleeping after the snapshot applied');
        assert.strictEqual(send.status, 'invalid: TICK (sleeping)', 'a SEND of the sleeping copy graded ' + send.status);
    });
});

bridgeRailSuite(GROUP, function () {
    it('policy AT6 (burn): a v4 burn of the sleeping copy is refused while the tick sleeps and moves no balance', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT6 burn')) return;
        const M = state.policy.main;
        assert.ok(M.sleepSeq, 'the sleep half must have run');
        assert.ok(state.evidence.at6_sleep && state.evidence.at6_sleep.copySleeping === true, 'the sleep half must have run and slept the copy');
        M.btcReceiver = await fundBtc('POLICY.AT6.RECEIVER');
        const before = await state.venue.addressBalance('DOGE', M.dest.address, 'BTC.' + M.tick);
        const burn = await dogeAction(M.dest, burnWireV4('BTC.' + M.tick, M.btcReceiver.address, 1, 'policy AT6 burn'), 'xbridges');
        const after = await state.venue.addressBalance('DOGE', M.dest.address, 'BTC.' + M.tick);
        const received = await state.venue.addressBalance('BTC', M.btcReceiver.address, M.tick);
        state.evidence.at6_burn = { burn, before, after, received };
        assert.strictEqual(burn.status, 'invalid: TICK (sleeping)', 'a v4 burn of the sleeping copy graded ' + burn.status);
        assert.strictEqual(Number(after), Number(before), M.dest.address + ' holds ' + after + ' BTC.' + M.tick + ' after the refused burn, was ' + before);
        assert.strictEqual(Number(received), 0, M.btcReceiver.address + ' holds ' + received + ' ' + M.tick + ' after a refused burn');
    });
});

bridgeRailSuite(GROUP, function () {
    it('policy AT6 (wake): the issuer wakes the token and the copy wakes within one cycle, a SEND of the copy applying again', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT6 wake')) return;
        const M = state.policy.main;
        assert.ok(M.sleepSeq, 'the sleep half must have run');
        assert.ok(state.evidence.at6_sleep && state.evidence.at6_sleep.copySleeping === true, 'the sleep half must have run and slept the copy');
        const previous = newestFinalizedSnapshot(await hubPolicyRows(M.tick), M.tick);
        assert.ok(previous, 'the wake needs an existing finalized snapshot for ' + M.tick);
        const { wake, attempts } = await sendWakeAtFreshTip(M);
        state.evidence.at6_wake = { wake, attempts };
        assert.strictEqual(wake.status, 'valid', 'the issuer wake of ' + M.tick + ' graded ' + wake.status);
        let woke = null;
        await state.venue.waitUntil('a later finalized policy_snapshots row for ' + M.tick, async () => {
            woke = nextFinalizedSnapshot(await hubPolicyRows(M.tick), M.tick, previous);
            return !!woke;
        }, {
            timeoutMs: policyFinalizationBudgetMs(state.venue.pollMs || 15000),
            everyMs: 5000,
        });
        assert.strictEqual(Number(woke.sleeping), 0, 'seq ' + woke.policy_seq + ' carries sleeping ' + woke.sleeping);
        await waitForAppliedSeq(M.tick, Number(woke.policy_seq));
        const copy = await copyPolicy(M.tick);
        const send = await sendCopy(M.dest, M.tick, 1, M.other.address, 'policy AT6 awake');
        Object.assign(state.evidence.at6_wake, { seq: String(woke.snapshot_id), copySleeping: copy.sleeping, send });
        assert.strictEqual(copy.sleeping, false, 'the copy still reads sleeping after the wake snapshot applied');
        assert.strictEqual(send.status, 'valid', 'a SEND of the woken copy graded ' + send.status);
    });
});
