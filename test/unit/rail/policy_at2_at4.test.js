'use strict'

const assert = require('assert')

const {
    appliedPolicyMatch,
    dogeFeeSchedule,
    expandPolicyTickCandidates,
    freshInputCount,
    joinAppliedPolicyRows,
    policyApplyBudgetMs,
    policyTransferMatches,
    spendableInputCount,
} = require('../../helpers/rail_preflight/policy_at2_at4')

describe('policy AT2 and AT4 rail decisions', function () {
    it('allocates one fresh input per edit when the existing candidate is reserved', function () {
        const journal = {
            candidates: 1,
            error: 'insufficient funds: all 1 candidate input(s) are reserved by a transaction built in the last 5 minutes',
        }
        assert.match(journal.error, /all 1 candidate input\(s\) are reserved/)
        assert.strictEqual(freshInputCount(2), 2)
        assert.strictEqual(spendableInputCount([
            { txid: 'fund-a', vout: 0, confirmations: 1 },
            { txid: 'fund-a', vout: 0, confirmations: 1 },
            { txid: 'mempool', vout: 1, confirmations: 0 },
        ]), 1)
    })

    it('budgets beyond the recorded DOGE apply timeout', function () {
        const journal = { durationMs: 1705946, transferId: 'c70e67fa07f42a3a' }
        assert.ok(policyApplyBudgetMs('DOGE') > journal.durationMs + 5000)
        assert.strictEqual(policyApplyBudgetMs('BTC'), 70 * 60 * 1000)
    })

    it('matches the recorded transfer by source leg and destination', function () {
        const row = {
            transfer_id: 'c70e67fa07f42a3a', src_chain: 'BTC', src_action_index: 283,
            dest_chain: 'DOGE', dest_address: 'mmvPzievv97b6zqkSegVHt7W4XkgZY8Nop', tick: 'GAPA',
        }
        assert.strictEqual(policyTransferMatches(row, {
            srcChain: 'BTC', srcActionIndex: 283, destChain: 'DOGE',
            destAddress: row.dest_address, tick: 'GAPA',
        }), true)
        assert.strictEqual(policyTransferMatches(row, {
            srcChain: 'BTC', srcActionIndex: 318, destChain: 'DOGE',
            destAddress: row.dest_address, tick: 'GAPA',
        }), false)
    })

    it('extends every exhausted policy tick family without dropping the requested names', function () {
        for (const initial of [
            ['POLA', 'POLB', 'POLC', 'POLD'],
            ['GAPA', 'GAPB', 'GAPC'],
            ['LAGA', 'LAGB', 'LAGC'],
            ['RORA', 'RORB', 'RORC'],
        ]) {
            const expanded = expandPolicyTickCandidates(initial)
            assert.deepStrictEqual(expanded.slice(0, initial.length), initial)
            assert.ok(expanded.length > initial.length)
            assert.strictEqual(new Set(expanded).size, expanded.length)
        }
    })

    it('reads DOGE fee readiness from the venue schedule', function () {
        assert.deepStrictEqual(dogeFeeSchedule(null), { ready: false, destination: null })
        assert.deepStrictEqual(dogeFeeSchedule({}), { ready: false, destination: null })
        assert.deepStrictEqual(dogeFeeSchedule({ nativeFeeEnabled: true, feeDestination: '' }),
            { ready: false, destination: null })
        assert.deepStrictEqual(dogeFeeSchedule({ nativeFeeEnabled: true, feeDestination: 'DPolicyFee' }),
            { ready: true, destination: 'DPolicyFee' })
    })
})

describe('policy application row identity', function () {
    it('joins settlements only to the same snapshot id', function () {
        const settlements = [
            { transfer_id: 'old-id', block_index: 18990, action_index: 51 },
            { transfer_id: 'new-id', block_index: 19013, action_index: 54 },
        ]
        const mirrored = [
            { id: 7, snapshot_id: 'prior-hub-id', policy_seq: 1, policy_hash: 'old', sleeping: 0 },
            { id: 7, snapshot_id: 'new-id', policy_seq: 2, policy_hash: 'new', sleeping: 0 },
        ]
        assert.deepStrictEqual(joinAppliedPolicyRows(settlements, mirrored), [{
            snapshotId: 'new-id', block: 19013, actionIndex: 54, seq: 2, hash: 'new', sleeping: 0,
        }])
    })

    it('requires the requested snapshot when reading an applied sequence', function () {
        const rows = [
            { snapshotId: 'prior', seq: 3 },
            { snapshotId: 'wanted', seq: 3 },
        ]
        assert.deepStrictEqual(appliedPolicyMatch(rows, { minSeq: 3, snapshotId: 'wanted' }), rows[1])
        assert.strictEqual(appliedPolicyMatch(rows, { minSeq: 4, snapshotId: 'wanted' }), null)
    })
})
