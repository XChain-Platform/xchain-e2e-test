'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const {
    policyListsWire,
} = require('../../helpers/bridgeRailVenue');
const { DETACH_STEPS } = require('../../helpers/bridge_detach_plan');
const {
    assert,
    GAS_TICK,
    state,
    issueHelper,
    lockWireV3,
    optInWire,
    btcAction,
    fundBtc,
    fundDoge,
    pickFreeTick,
    settleLeg,
    chainHalves,
    btcAddressList,
    copyPolicy,
    waitForFinalizedSeq,
    waitForAppliedSeq,
    sendCopy,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'policy AT11: a null list detaches the copy';
const LOCK = 5;

function detachState() {
    if (!state.policy.detach) state.policy.detach = {};
    return state.policy.detach;
}

function freshTickCandidates() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const candidates = new Set();
    while (candidates.size < 16) {
        const bytes = crypto.randomBytes(5);
        candidates.add(Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join(''));
    }
    return [...candidates];
}

async function armEngine() {
    if (state.baseline) return;
    const overlay = await state.venue.rewireHubs();
    const settled = await state.venue.waitForRailSettled(GAS_TICK, { timeoutMs: 60 * 60 * 1000 });
    assert.ok(settled, 'the XCHAIN backlog never drained: ' + JSON.stringify(state.venue._lastSettlePoll) +
        '\n' + state.venue.indexerTails(40));
    const dupes = await state.venue.duplicateSourceTransfers();
    assert.deepStrictEqual(dupes, [],
        'the federation finalized ' + dupes.length + ' source leg(s) more than once: ' + JSON.stringify(dupes));
    state.baseline = { xchain: await chainHalves(), invariant: settled.invariant || null };
    state.evidence.at11_engine = { env: Object.keys(overlay).sort(), baseline: state.baseline };
}

async function issueListedTick() {
    await armEngine();
    const M = detachState();
    M.issuer = await fundBtc('POLICY.AT11.ISSUER');
    M.dest = await fundDoge('POLICY.AT11.DEST', 5);
    M.blocked = await fundDoge('POLICY.AT11.BLOCKED', 1);
    M.tick = await pickFreeTick(freshTickCandidates());
    assert.ok(M.tick, 'no fresh tick candidate was free on both ledgers');
    M.issue = await btcAction(M.issuer, () => issueHelper.sendIssueV0Raw(
        M.issuer, M.tick, 100000, 100000, 0, 'policy AT11', 1000), 'issues');
    assert.strictEqual(M.issue.status, 'valid', 'ISSUE ' + M.tick + ' graded ' + M.issue.status);
    M.allowList = await btcAddressList(M.issuer, [M.dest.address, M.blocked.address], 'policy AT11 allow list');
    M.blockList = await btcAddressList(M.issuer, [M.blocked.address], 'policy AT11 block list');
    M.attach = await btcAction(M.issuer,
        policyListsWire(M.tick, M.allowList, M.blockList, 'policy AT11 attach'), 'issues');
    assert.strictEqual(M.attach.status, 'valid', 'ISSUE|5 attaching both lists graded ' + M.attach.status);
    M.optIn = await btcAction(M.issuer, optInWire(M.tick, 'DOGE', '', '', 'policy AT11 opt-in'), 'issues');
    assert.strictEqual(M.optIn.status, 'valid', 'ISSUE|7 on the listed token graded ' + M.optIn.status);
    state.policy.ticks.push(M.tick);
    state.evidence.at11_issue = { tick: M.tick, allowList: M.allowList, blockList: M.blockList };
}

async function bridgeTick() {
    const M = detachState();
    assert.ok(M.tick, 'the issue step must have run');
    M.lock = await btcAction(M.issuer,
        lockWireV3(M.tick, 'DOGE', M.dest.address, LOCK, 'policy AT11'), 'xbridges');
    assert.strictEqual(M.lock.status, 'valid', 'the v3 lock of ' + M.tick + ' graded ' + M.lock.status);
    M.leg = await settleLeg('the policy AT11 lock',
        (row) => String(row.dest_address) === M.dest.address && String(row.tick) === M.tick, 'DOGE');
    state.evidence.at11_bridge = { lock: M.lock, transfer: M.leg.transfer };
}

async function settleInitialSnapshot(step) {
    const M = detachState();
    assert.ok(M.leg, 'the bridge step must have run');
    M.seq1 = await waitForFinalizedSeq(M.tick, 1);
    M.applied1 = await waitForAppliedSeq(M.tick, 1);
    M.copy1 = await state.venue.tokenParameters('DOGE', 'BTC.' + M.tick);
    M.policy1 = await copyPolicy(M.tick);
    assert.ok(M.copy1 && Number(M.copy1.params.allow_list) > 0,
        'the copy ALLOW_LIST is not ' + step.expect.ALLOW_LIST);
    assert.ok(Number(M.copy1.params.block_list) > 0,
        'the copy BLOCK_LIST is not ' + step.expect.BLOCK_LIST);
    assert.deepStrictEqual(M.policy1.allow_list, [M.dest.address, M.blocked.address],
        'the copy allow list reads ' + JSON.stringify(M.policy1.allow_list));
    assert.deepStrictEqual(M.policy1.block_list, [M.blocked.address],
        'the copy block list reads ' + JSON.stringify(M.policy1.block_list));
    state.evidence.at11_initial = { snapshot: M.seq1.snapshot_id, applied: M.applied1,
        allowList: M.copy1.params.allow_list, blockList: M.copy1.params.block_list };
}

async function detachOrigin(step) {
    const M = detachState();
    assert.ok(M.copy1, 'the initial snapshot step must have run');
    M.detach = await btcAction(M.issuer,
        policyListsWire(M.tick, null, step.sentinel, 'policy AT11 detach'), 'issues');
    assert.strictEqual(M.detach.status, 'valid',
        'ISSUE|' + step.issueFormat + ' detaching the BLOCK_LIST graded ' + M.detach.status);
    state.evidence.at11_detach = M.detach;
}

async function settleDetachedSnapshot(step) {
    const M = detachState();
    assert.ok(M.detach && M.detach.status === 'valid', 'the detach step must have run');
    const nextSeq = Number(M.seq1.policy_seq) + 1;
    M.seq2 = await waitForFinalizedSeq(M.tick, nextSeq);
    assert.strictEqual(Number(M.seq2.policy_seq), nextSeq,
        'the detach finalized as seq ' + M.seq2.policy_seq + ', not ' + nextSeq);
    M.applied2 = await waitForAppliedSeq(M.tick, nextSeq);
    M.copy2 = await state.venue.tokenParameters('DOGE', 'BTC.' + M.tick);
    M.policy2 = await copyPolicy(M.tick);
    assert.strictEqual(M.copy2.params.allow_list, M.copy1.params.allow_list,
        'the copy ALLOW_LIST changed from ' + M.copy1.params.allow_list + ' to ' + M.copy2.params.allow_list);
    assert.strictEqual(M.copy2.params.block_list, null, 'the copy BLOCK_LIST did not detach');
    assert.strictEqual(Number(M.copy2.params.block_list || 0), step.expect.BLOCK_LIST,
        'the detached copy BLOCK_LIST does not read as zero');
    assert.deepStrictEqual(M.policy2.allow_list, M.policy1.allow_list,
        'the copy allow-list membership changed after detach');
    assert.strictEqual(M.policy2.block_list, null, 'gettokenpolicy materialized an absent block list');
    state.evidence.at11_detached = { snapshot: M.seq2.snapshot_id, applied: M.applied2,
        ALLOW_LIST: M.copy2.params.allow_list, BLOCK_LIST: Number(M.copy2.params.block_list || 0) };
}

async function sendToFormerlyBlocked(step) {
    const M = detachState();
    assert.ok(M.copy2, 'the detached snapshot step must have run');
    M.send = await sendCopy(M.dest, M.tick, 1, M.blocked.address, 'policy AT11 formerly blocked');
    assert.strictEqual(M.send.status, step.expect.status,
        'a SEND to the formerly blocked address graded ' + M.send.status);
    state.evidence.at11_send = M.send;
}

const ACTIONS = {
    issue_btc_tick_with_lists: issueListedTick,
    bridge_btc_tick_to_doge: bridgeTick,
    wait_for_initial_snapshot: settleInitialSnapshot,
    detach_origin_block_list: detachOrigin,
    wait_for_detached_snapshot: settleDetachedSnapshot,
    send_to_formerly_blocked: sendToFormerlyBlocked,
};

bridgeRailSuite(GROUP, function () {
    for (const step of DETACH_STEPS) {
        it('policy AT11: ' + step.name, async function () {
            this.timeout(0);
            if (needsFederation(this, 'policy AT11 ' + step.action)) return;
            assert.strictEqual(typeof ACTIONS[step.action], 'function', 'no rail action for ' + step.action);
            await ACTIONS[step.action](step);
        });
    }
});
