'use strict';

const assert = require('assert');

const {
    barrierWaitReady,
    finalizedPolicyRows,
    followerRecoveryPlan,
    policyReleaseReading,
} = require('../../helpers/rail_preflight/policy_at5');

describe('policy AT5 rail decisions', function () {
    it('observes the withheld barrier after effective time without requiring the parked indexer to advance', function () {
        const transfer = { transferId: 'lag-transfer', effectiveTime: 1790487200, settled: null };

        assert.strictEqual(barrierWaitReady(transfer, 1790487204), false);
        assert.strictEqual(barrierWaitReady(transfer, 1790487205), true);
    });

    it('does not let an absent transfer or an early clock satisfy the barrier wait', function () {
        assert.strictEqual(barrierWaitReady(null, 1790487205), false);
        assert.strictEqual(barrierWaitReady({ effectiveTime: null }, 1790487205), false);
        assert.strictEqual(barrierWaitReady({ effectiveTime: 1790487200 }, 1790487199), false);
    });

    it('matches every finalized row at or above the requested sequence', function () {
        const rows = [
            { tick: 'LAGA', policy_seq: 1n, status: 'finalized', snapshot_id: 'seq-1' },
            { tick: 'LAGA', policy_seq: 2n, status: 'pending', snapshot_id: 'seq-2-pending' },
            { tick: 'LAGA', policy_seq: 3n, status: 'finalized', snapshot_id: 'seq-3' },
        ];

        assert.deepStrictEqual(finalizedPolicyRows(rows, 2).map((row) => row.snapshot_id), ['seq-3']);
    });

    it('restarts the restored follower first and every peer after a one-process restart', function () {
        assert.deepStrictEqual(followerRecoveryPlan(3, 2), [2, 0, 1]);
        assert.deepStrictEqual(followerRecoveryPlan(3, 0), [0, 1, 2]);
    });

    it('rejects a recovery plan that cannot name a real follower', function () {
        assert.throws(() => followerRecoveryPlan(3, 3), /follower 3 is outside a 3-hub venue/);
        assert.throws(() => followerRecoveryPlan(0, 0), /hub count must be a positive integer/);
    });

    it('reads the recorded early transfer as an ordering failure', function () {
        const reading = policyReleaseReading(
            { block: 18203, actionIndex: 3734 },
            { settled: { block_index: 18197n, action_index: 3727n } }
        );

        assert.deepStrictEqual(reading, {
            transferBlock: 18197,
            policyBlock: 18203,
            transferAction: 3727,
            policyAction: 3734,
            sameBlock: false,
            policyFirst: false,
        });
    });

    it('accepts only a same-block release with the policy action first', function () {
        assert.deepStrictEqual(
            policyReleaseReading(
                { block: 18368, actionIndex: 3747 },
                { settled: { block_index: 18368, action_index: 3748 } }
            ),
            {
                transferBlock: 18368,
                policyBlock: 18368,
                transferAction: 3748,
                policyAction: 3747,
                sameBlock: true,
                policyFirst: true,
            }
        );
    });

    it('keeps an absent release reading from looking like block zero', function () {
        const reading = policyReleaseReading(null, null);

        assert.strictEqual(reading.sameBlock, false);
        assert.strictEqual(reading.policyFirst, false);
        assert.strictEqual(Number.isNaN(reading.transferBlock), true);
        assert.strictEqual(Number.isNaN(reading.policyBlock), true);
    });
});
