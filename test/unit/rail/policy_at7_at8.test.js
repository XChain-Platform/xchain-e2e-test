'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const INVARIANT_SUITE = path.resolve(__dirname,
    '../../integration/bridge_rail_policy.test/09_at8_invariants_cap_and_destination_reorg.test.js');

const {
    bridgeLockRowMatches,
    feeScheduleBudgetMs,
    feeScheduleReady,
    newestFinalizedSnapshot,
    nextFinalizedSnapshot,
    policyFinalizationBudgetMs,
    policyInvariantOriginLookup,
    policyInvariantReading,
} = require('../../helpers/rail_preflight/policy_at7_at8');

describe('policy AT7 and AT8 readiness and snapshot decisions', function () {
    it('waits for the populated native-fee schedule seen by the DOGE action path', function () {
        assert.strictEqual(feeScheduleReady(null), false);
        assert.strictEqual(feeScheduleReady({}), false);
        assert.strictEqual(feeScheduleReady({ error: 'indexer not ready' }), false);
        assert.strictEqual(feeScheduleReady({ nativeFeeEnabled: true, feeDestination: '' }), false);
        assert.strictEqual(feeScheduleReady({ nativeFeeEnabled: false, feeDestination: 'Dfee' }), false);
        assert.strictEqual(feeScheduleReady({ nativeFeeEnabled: true, feeDestination: 'Dfee' }), true);
        assert.strictEqual(feeScheduleBudgetMs(15000), 10 * 60 * 1000);
        assert.throws(() => feeScheduleBudgetMs(-1), /poll cadence/);
    });

    it('selects the newest finalized row for the requested tick', function () {
        const rows = [
            { snapshot_id: 'pola-1', tick: 'POLA', policy_seq: 1, origin_block: 26158, status: 'finalized' },
            { snapshot_id: 'other-9', tick: 'LAGA', policy_seq: 9, origin_block: 27000, status: 'finalized' },
            { snapshot_id: 'pola-pending', tick: 'POLA', policy_seq: 4, origin_block: 26900, status: 'pending' },
            { snapshot_id: 'pola-3', tick: 'POLA', policy_seq: 3, origin_block: 26800, status: 'finalized' },
            { snapshot_id: 'pola-2', tick: 'POLA', policy_seq: 2, origin_block: 26700, status: 'finalized' },
        ];
        assert.strictEqual(newestFinalizedSnapshot(rows, 'POLA').snapshot_id, 'pola-3');
        assert.strictEqual(newestFinalizedSnapshot(rows, 'POLB'), null);
    });

    it('requires a later finalized sequence for each cap edit', function () {
        const before = { snapshot_id: 'polb-2', tick: 'POLB', policy_seq: 2, status: 'finalized' };
        const rows = [
            before,
            { snapshot_id: 'polb-2-copy', tick: 'POLB', policy_seq: 2, status: 'finalized' },
            { snapshot_id: 'polc-3', tick: 'POLC', policy_seq: 3, status: 'finalized' },
            { snapshot_id: 'polb-3-pending', tick: 'POLB', policy_seq: 3, status: 'pending' },
            { snapshot_id: 'polb-3', tick: 'POLB', policy_seq: 3, status: 'finalized' },
        ];
        assert.strictEqual(nextFinalizedSnapshot(rows, 'POLB', before).snapshot_id, 'polb-3');
        assert.strictEqual(nextFinalizedSnapshot(rows.slice(0, 4), 'POLB', before), null);
    });

    it('allows three ten-minute consensus rounds instead of ending at 1200 seconds', function () {
        assert.strictEqual(policyFinalizationBudgetMs(15000), 30 * 60 * 1000);
        assert.ok(policyFinalizationBudgetMs(5 * 60 * 1000) >= 30 * 60 * 1000);
        assert.throws(() => policyFinalizationBudgetMs(0), /poll cadence/);
    });
});

describe('policy AT8 invariant and reorg decisions', function () {
    it('passes the finalized snapshot origin block to the origin policy read', function () {
        const source = fs.readFileSync(INVARIANT_SUITE, 'utf8');
        assert.match(source,
            /originPolicy\(originLookup\.tick,\s*originLookup\.block\)/);
    });

    it('compares each copy with the origin at its finalized snapshot block', function () {
        const snapshot = {
            tick: 'LAGA',
            policy_seq: 3,
            origin_block: 26800,
            snapshot_block: 26806,
            status: 'finalized',
        };
        assert.deepStrictEqual(policyInvariantOriginLookup(snapshot), {
            tick: 'LAGA',
            block: 26800,
        });
        assert.throws(() => policyInvariantOriginLookup({ ...snapshot, status: 'pending' }),
            /snapshot must be finalized/);
        const reading = policyInvariantReading([
            { tick: 'LAGA', originHash: 'old-a', copyHash: 'old-a', appliedHash: 'old-a' },
            { tick: 'POLA', originHash: 'old-b', copyHash: 'old-b', appliedHash: 'old-b' },
        ], 2);
        assert.deepStrictEqual(reading, { enough: true, covered: 2, mismatches: [] });
    });

    it('preserves the invariant coverage and equality failures', function () {
        assert.deepStrictEqual(policyInvariantReading([], 2), {
            enough: false,
            covered: 0,
            mismatches: [],
        });
        assert.deepStrictEqual(policyInvariantReading([
            { tick: 'LAGC', originHash: 'new', copyHash: 'old', appliedHash: 'new' },
        ], 1), {
            enough: true,
            covered: 1,
            mismatches: [{ tick: 'LAGC', copy: true, applied: false }],
        });
    });

    it('matches the current reorg lock by its source action index', function () {
        const expected = { tick: 'RORA', destAddress: 'Ddest', actionIndex: 4102 };
        const stale = { tick: 'RORA', dest_address: 'Ddest', src_action_index: 2359 };
        const fresh = { tick: 'RORA', dest_address: 'Ddest', src_action_index: 4102 };
        assert.strictEqual(bridgeLockRowMatches(stale, expected), false);
        assert.strictEqual(bridgeLockRowMatches(fresh, expected), true);
    });
});
