'use strict';

const assert = require('assert');

function barrierWaitReady(transfer, nowSeconds, graceSeconds = 5) {
    if (!transfer || typeof transfer !== 'object') return false;
    if (transfer.effectiveTime === null || transfer.effectiveTime === undefined) return false;
    const effective = Number(transfer.effectiveTime);
    const now = Number(nowSeconds);
    const grace = Number(graceSeconds);
    if (!Number.isFinite(effective) || !Number.isFinite(now) || !Number.isFinite(grace) || grace < 0) return false;
    return now >= effective + grace;
}

function finalizedPolicyRows(rows, minimumSequence) {
    const minimum = Number(minimumSequence);
    assert.ok(Number.isInteger(minimum) && minimum >= 1,
        'finalizedPolicyRows: minimum sequence must be a positive integer, got ' + minimumSequence);
    return (Array.isArray(rows) ? rows : []).filter((row) => row &&
        String(row.status) === 'finalized' && Number(row.policy_seq) >= minimum);
}

function followerRecoveryPlan(hubCount, follower) {
    const count = Number(hubCount);
    const selected = Number(follower);
    assert.ok(Number.isInteger(count) && count > 0,
        'followerRecoveryPlan: hub count must be a positive integer, got ' + hubCount);
    assert.ok(Number.isInteger(selected) && selected >= 0 && selected < count,
        'followerRecoveryPlan: follower ' + follower + ' is outside a ' + count + '-hub venue');
    const plan = [selected];
    for (let index = 0; index < count; index += 1) if (index !== selected) plan.push(index);
    return plan;
}

function policyReleaseReading(policy, transfer) {
    const settled = transfer && transfer.settled;
    const transferBlock = Number(settled ? settled.block_index : undefined);
    const policyBlock = Number(policy ? policy.block : undefined);
    const transferAction = Number(settled ? settled.action_index : undefined);
    const policyAction = Number(policy ? policy.actionIndex : undefined);
    const finite = [transferBlock, policyBlock, transferAction, policyAction].every(Number.isFinite);
    return {
        transferBlock,
        policyBlock,
        transferAction,
        policyAction,
        sameBlock: finite && transferBlock === policyBlock,
        policyFirst: finite && transferBlock === policyBlock && policyAction < transferAction,
    };
}

module.exports = {
    barrierWaitReady,
    finalizedPolicyRows,
    followerRecoveryPlan,
    policyReleaseReading,
};
