'use strict';

const assert = require('assert');

const MIN_FEE_SCHEDULE_BUDGET_MS = 10 * 60 * 1000;
const MIN_FINALIZATION_BUDGET_MS = 30 * 60 * 1000;

function feeScheduleReady(schedule) {
    return !!schedule && !schedule.error && schedule.nativeFeeEnabled === true &&
        typeof schedule.feeDestination === 'string' && schedule.feeDestination.length > 0;
}

function feeScheduleBudgetMs(pollMs) {
    const cadence = Number(pollMs);
    assert.ok(Number.isFinite(cadence) && cadence > 0,
        'feeScheduleBudgetMs: poll cadence must be a positive number');
    return Math.max(MIN_FEE_SCHEDULE_BUDGET_MS, cadence * 6);
}

function finalizedForTick(rows, tick) {
    return (rows || []).filter((row) => String(row.tick) === String(tick) &&
        String(row.status) === 'finalized');
}

function compareSnapshotRows(a, b) {
    const seq = Number(a.policy_seq) - Number(b.policy_seq);
    if (seq !== 0) return seq;
    const origin = Number(a.origin_block) - Number(b.origin_block);
    if (origin !== 0) return origin;
    return Number(a.snapshot_block) - Number(b.snapshot_block);
}

function newestFinalizedSnapshot(rows, tick) {
    const finalized = finalizedForTick(rows, tick).sort(compareSnapshotRows);
    return finalized.length ? finalized[finalized.length - 1] : null;
}

function nextFinalizedSnapshot(rows, tick, previous) {
    const previousSeq = Number(previous && previous.policy_seq);
    assert.ok(Number.isInteger(previousSeq) && previousSeq >= 1,
        'nextFinalizedSnapshot: previous policy_seq must be a positive integer');
    const later = finalizedForTick(rows, tick)
        .filter((row) => Number(row.policy_seq) > previousSeq)
        .sort(compareSnapshotRows);
    return later.length ? later[0] : null;
}

function policyFinalizationBudgetMs(pollMs) {
    const cadence = Number(pollMs);
    assert.ok(Number.isFinite(cadence) && cadence > 0,
        'policyFinalizationBudgetMs: poll cadence must be a positive number');
    return Math.max(MIN_FINALIZATION_BUDGET_MS, cadence * 6);
}

function policyInvariantOriginLookup(snapshot) {
    assert.ok(snapshot && String(snapshot.status) === 'finalized',
        'policyInvariantOriginLookup: snapshot must be finalized');
    const tick = String(snapshot.tick || '');
    const block = Number(snapshot.origin_block);
    assert.ok(tick.length > 0, 'policyInvariantOriginLookup: snapshot tick is required');
    assert.ok(Number.isInteger(block) && block >= 0,
        'policyInvariantOriginLookup: origin_block must be a non-negative integer');
    return { tick, block };
}

function policyInvariantReading(readings, minimum) {
    const rows = Array.isArray(readings) ? readings : [];
    const needed = Number(minimum);
    assert.ok(Number.isInteger(needed) && needed > 0,
        'policyInvariantReading: minimum must be a positive integer');
    const mismatches = rows.filter((row) => String(row.copyHash) !== String(row.originHash) ||
        String(row.appliedHash) !== String(row.originHash)).map((row) => ({
        tick: String(row.tick),
        copy: String(row.copyHash) !== String(row.originHash),
        applied: String(row.appliedHash) !== String(row.originHash),
    }));
    return { enough: rows.length >= needed, covered: rows.length, mismatches };
}

function bridgeLockRowMatches(row, expected) {
    if (!row || !expected) return false;
    return String(row.tick) === String(expected.tick) &&
        String(row.dest_address) === String(expected.destAddress) &&
        String(row.src_action_index) === String(expected.actionIndex);
}

module.exports = {
    bridgeLockRowMatches,
    feeScheduleBudgetMs,
    feeScheduleReady,
    newestFinalizedSnapshot,
    nextFinalizedSnapshot,
    policyFinalizationBudgetMs,
    policyInvariantOriginLookup,
    policyInvariantReading,
};
