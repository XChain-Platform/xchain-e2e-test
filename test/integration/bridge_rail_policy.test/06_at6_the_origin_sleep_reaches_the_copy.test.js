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
 * sleeping 1 and transfers of the copy are `invalid: TICK (sleeping)`; a v4 burn still applies
 * (token spec D44); the issuer wakes it and the copy wakes within one cycle.
 *
 * THE WAKE is a SLEEP format 1 whose RESUME_BLOCK is the next BTC block: the sleep read treats
 * a row as asleep only at -1 or a future block (policy spec section 4, D8), so the origin reads
 * awake from that block on and the next snapshot carries sleeping 0.
 *
 ********************************************************************/

'use strict';

const { sleepTickWire } = require('../../helpers/bridgeRailVenue');
const {
    assert,
    burnWireV4,
    state,
    btcAction,
    dogeAction,
    fundBtc,
    settleLeg,
    hubPolicyRows,
    waitForFinalizedSeq,
    waitForAppliedSeq,
    copyPolicy,
    sendCopy,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'policy AT6: the origin sleep reaches the copy';

// The next seq the federation must sign for `tick`: one past its newest finalized row.
async function nextSeq(tick) {
    const rows = (await hubPolicyRows(tick)).filter((r) => String(r.status) === 'finalized');
    return rows.length ? Number(rows[rows.length - 1].policy_seq) + 1 : 1;
}

bridgeRailSuite(GROUP, function () {
    it('policy AT6 (sleep): the issuer sleeps the token on BTC, DOGE applies sleeping 1 and a SEND of the copy is invalid: TICK (sleeping)', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT6 sleep')) return;
        const M = state.policy.main;
        assert.ok(M.seq2, 'AT2 must have run');
        const seq = await nextSeq(M.tick);
        const sleep = await btcAction(M.issuer, sleepTickWire(M.tick, -1, 'policy AT6 sleep'), 'sleeps');
        assert.strictEqual(sleep.status, 'valid', 'the issuer SLEEP of ' + M.tick + ' graded ' + sleep.status);
        M.sleepSeq = await waitForFinalizedSeq(M.tick, seq);
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
    it('policy AT6 (burn): a v4 burn of the sleeping copy still applies and the BTC side releases it', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT6 burn')) return;
        const M = state.policy.main;
        assert.ok(M.sleepSeq, 'the sleep half must have run');
        M.btcReceiver = await fundBtc('POLICY.AT6.RECEIVER');
        const burn = await dogeAction(M.dest, burnWireV4('BTC.' + M.tick, M.btcReceiver.address, 1, 'policy AT6 burn'), 'xbridges');
        state.evidence.at6_burn = { burn };
        assert.strictEqual(burn.status, 'valid', 'a v4 burn of the sleeping copy graded ' + burn.status);
        const leg = await settleLeg('the policy AT6 burn',
            (r) => String(r.src_chain) === 'DOGE' && String(r.dest_address) === M.btcReceiver.address && String(r.tick) === M.tick, 'BTC');
        state.evidence.at6_burn.transfer = leg.transfer;
        const received = await state.venue.addressBalance('BTC', M.btcReceiver.address, M.tick);
        assert.strictEqual(Number(received), 1, M.btcReceiver.address + ' holds ' + received + ' ' + M.tick + ' after the burn released');
    });
});

bridgeRailSuite(GROUP, function () {
    it('policy AT6 (wake): the issuer wakes the token and the copy wakes within one cycle, a SEND of the copy applying again', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT6 wake')) return;
        const M = state.policy.main;
        assert.ok(M.sleepSeq, 'the sleep half must have run');
        const seq = await nextSeq(M.tick);
        const wakeAt = Number(await nodeConnector.getBlockCount()) + 1;
        const wake = await btcAction(M.issuer, sleepTickWire(M.tick, wakeAt, 'policy AT6 wake'), 'sleeps');
        assert.strictEqual(wake.status, 'valid', 'the issuer wake of ' + M.tick + ' graded ' + wake.status);
        const woke = await waitForFinalizedSeq(M.tick, seq);
        assert.strictEqual(Number(woke.sleeping), 0, 'seq ' + woke.policy_seq + ' carries sleeping ' + woke.sleeping);
        await waitForAppliedSeq(M.tick, Number(woke.policy_seq));
        const copy = await copyPolicy(M.tick);
        const send = await sendCopy(M.dest, M.tick, 1, M.other.address, 'policy AT6 awake');
        state.evidence.at6_wake = { wake, wakeAt, seq: String(woke.snapshot_id), copySleeping: copy.sleeping, send };
        assert.strictEqual(copy.sleeping, false, 'the copy still reads sleeping after the wake snapshot applied');
        assert.strictEqual(send.status, 'valid', 'a SEND of the woken copy graded ' + send.status);
    });
});
