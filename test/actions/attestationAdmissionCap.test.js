// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const cryptoHelper = require('../helpers/core/cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')
const vmHelper = require('../helpers/vmHelper')
const attestationHelper = require('../helpers/attestationHelper')

/**
 * ATTEST v0 per-block admission caps (framework spec §11.1), observed on a LIVE
 * regtest indexer rather than a stubbed handler.
 *
 * The indexer's cap (xchain-indexer src/attest_request_cap_activation.js, armed at
 * genesis on regtest) admits at most ATTEST_REQUEST_CAPS.perContract = 2 requests
 * per contract per block and perBlock = 10 per block. The unit suite proves the
 * handler logic against a stubbed admission count; this suite proves the whole
 * path end to end: VM emission -> processEmission -> attest handler -> the count
 * query against real earlier admissions in the same block.
 *
 * What "rejects" looks like from the outside. An over-cap v0 is not a standalone
 * user action: it is EMITTED by an EXECUTE, and processEmission throws on any
 * non-valid emission status, which rolls the WHOLE execution back to its savepoint.
 * So the observable evidence is the EXECUTE row itself: status != valid,
 * error_message naming 'ATTEST cap', emitted_count 0, and NO attests row for the
 * request (the handler's own 'rejected' row is inside the rolled-back savepoint).
 *
 * Three cases:
 *   1. exactly AT the per-contract cap (2 requests in one EXECUTE) still admits,
 *      so the rejection below is the cap firing and not a multi-emission bug;
 *   2. one EXECUTE emitting 3 requests: the third trips the cap and the execution
 *      reverts (the count sees the same EXECUTE's earlier emissions, which carry
 *      lower action_index values in the same DB transaction);
 *   3. two EXECUTEs from two callers mined into ONE block: whichever the block
 *      orders second finds the contract's share already taken and reverts. Block
 *      order is the miner's, so the assertion is on the invariant (at most 2
 *      admitted, the loser names the cap), not on which caller loses.
 */

describe('Attestation framework: per-contract admission cap rejects an over-cap ATTEST v0 on a live indexer', function () {

    // Mirrors ATTEST_REQUEST_CAPS.perContract in the indexer. Kept as a literal so a
    // silent change to the cap fails this suite loudly instead of tracking it.
    const PER_CONTRACT_CAP = 2

    let operatorAddr  = null
    let secondCaller  = null
    let contractIndex = null

    // Each request method emits N requests to the free http_get provider, one URL per
    // slot so the request_ids differ (request_id derives from the emitter position too,
    // but distinct payloads keep the rows readable in the attests table).
    const CONTRACT_CODE = `
module.exports = {
    askTwice: function(xchain) {
        var a = xchain.attestation.request('http_get', 'https://example.com/cap/at/1', 'handleResponse', ['cap-at-1'], { redundancy: 1, deadlineBlocks: 10 });
        var b = xchain.attestation.request('http_get', 'https://example.com/cap/at/2', 'handleResponse', ['cap-at-2'], { redundancy: 1, deadlineBlocks: 10 });
        xchain.state.set('at_cap_ids', a + ',' + b);
        return 'ok';
    },
    askThrice: function(xchain) {
        var a = xchain.attestation.request('http_get', 'https://example.com/cap/over/1', 'handleResponse', ['cap-over-1'], { redundancy: 1, deadlineBlocks: 10 });
        var b = xchain.attestation.request('http_get', 'https://example.com/cap/over/2', 'handleResponse', ['cap-over-2'], { redundancy: 1, deadlineBlocks: 10 });
        var c = xchain.attestation.request('http_get', 'https://example.com/cap/over/3', 'handleResponse', ['cap-over-3'], { redundancy: 1, deadlineBlocks: 10 });
        xchain.state.set('over_cap_ids', a + ',' + b + ',' + c);
        return 'ok';
    },
    askPair: function(xchain) {
        var a = xchain.attestation.request('http_get', 'https://example.com/cap/pair/1', 'handleResponse', ['cap-pair-1'], { redundancy: 1, deadlineBlocks: 10 });
        var b = xchain.attestation.request('http_get', 'https://example.com/cap/pair/2', 'handleResponse', ['cap-pair-2'], { redundancy: 1, deadlineBlocks: 10 });
        xchain.state.set('pair_ids', a + ',' + b);
        return 'ok';
    },
    askOnce: function(xchain) {
        var a = xchain.attestation.request('http_get', 'https://example.com/cap/single/1', 'handleResponse', ['cap-single-1'], { redundancy: 1, deadlineBlocks: 10 });
        xchain.state.set('single_id', a);
        return 'ok';
    },
    handleResponse: function(xchain) {
        xchain.state.set('last_callback_status', xchain.getInputParam(2));
    }
};
`

    // Admitted (non-rejected) v0 rows this contract holds in a block. Same predicate the
    // indexer's getAttestationAdmissionCounts uses, so the number here is the number the
    // cap compared against.
    async function admittedInBlock(blockIndex) {
        let connection = await indexerDatabase.getConnection()
        try {
            let rows = await connection.query(
                `SELECT COUNT(*) AS n FROM attests
                  WHERE version = 0 AND contract_index = ? AND block_index = ?
                    AND request_status <> 'rejected'`,
                [contractIndex, Number(blockIndex)]
            )
            return Number(rows[0].n)
        } finally { await connection.release() }
    }

    // Status-agnostic execution lookup by (contract, caller, method) with a bounded poll.
    // The valid-only waitForExecution can never observe a reverted execution.
    async function waitForAnyExecution(caller, method, timeMax = 60000) {
        let end = Date.now() + timeMax
        while (Date.now() < end) {
            let row = await indexerDatabase.checkExecution({
                contractIndex: contractIndex,
                caller:        caller,
                methodName:    method
            })
            if (row) return row
            await new Promise(r => setTimeout(r, 1000))
        }
        return null
    }

    function assertCapRevert(row, label) {
        assert(row, label + ': an execution row should be recorded')
        assert.notStrictEqual(row.status, 'valid', label + ': over-cap execution must not be valid')
        assert(String(row.error_message || '').includes('ATTEST cap'),
            label + ': error_message should name the admission cap, got: ' + row.error_message)
        assert.strictEqual(Number(row.emitted_count), 0,
            label + ': the whole execution rolls back, so no emission may be committed')
    }

    before(async function () {
        // Attestation rides on STAKE + EXECUTE (BTC-only protocol features).
        if (COIN_CODE !== 'BTC') {
            console.log('Attestation framework requires BTC chain; skipping on ' + COIN_CODE)
            this.skip()
            return
        }

        operatorAddr = await cryptoHelper.getNewFundedAddress('attest-cap-op', COIN, NETWORK, null, 'legacy', 0, 0.02)
        await gasHelper.ensureGasBalance(operatorAddr, '5000')
        secondCaller = await cryptoHelper.getNewFundedAddress('attest-cap-op', COIN, NETWORK, null, 'legacy', 1, 0.02)
        await gasHelper.ensureGasBalance(secondCaller, '2000')

        // The admission gate ahead of the cap needs a responsible set: at least one staked
        // validator clearing the http_get provider floor (10000). Staked from its OWN
        // source so SWQ source-dedup keeps it eligible (see attestation.test.js).
        let validator = new attestationHelper.MockAttestationValidator()
        let stakeSource = await cryptoHelper.getNewFundedAddress('attest-cap-val', COIN, NETWORK, null, 'legacy', 0, 0.02)
        await gasHelper.ensureGasBalance(stakeSource, '20000')
        await stakeHelper.sendStakeV1(stakeSource, '15000.00000000', validator.pubkey)
        validator.source = stakeSource.address
        attestationHelper.registerStakedValidator(validator)
        await regtestMinerConnector.generateBlocks(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS)
        await utxoTrackerConnector.requireSync()

        let deploy = await vmHelper.sendDeployV0(operatorAddr, CONTRACT_CODE, 500000)
        assert(deploy.contract, 'contract should deploy')
        assert.strictEqual(deploy.contract.status, 'valid', 'deploy status: ' + deploy.contract.status)
        contractIndex = deploy.contract.action_index
    })

    it('admits exactly PER_CONTRACT_CAP requests from one EXECUTE (the boundary is inclusive)', async function () {
        let exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askTwice', [])
        assert.strictEqual(exec.execution.status, 'valid', 'execute status: ' + exec.execution.status)
        assert.strictEqual(Number(exec.execution.emitted_count), PER_CONTRACT_CAP)

        let admitted = await admittedInBlock(exec.execution.block_index)
        assert.strictEqual(admitted, PER_CONTRACT_CAP, 'both at-cap requests should be pending')
    })

    it('rejects the request past the cap and reverts the emitting EXECUTE', async function () {
        let exec = await vmHelper.sendExecuteV0Invalid(operatorAddr, contractIndex, 'askThrice', [])
        assertCapRevert(exec.execution, 'askThrice')

        // The savepoint rollback takes the handler's own 'rejected' audit row with it, and
        // the two earlier emissions of the same EXECUTE as well: nothing from this block
        // may remain in the pending pool for the hub to serve.
        let admitted = await admittedInBlock(exec.execution.block_index)
        assert.strictEqual(admitted, 0, 'a reverted EXECUTE leaves no admitted request behind')
    })

    it('rejects across transactions: two callers in one block cannot exceed the contract share', async function () {
        // Hold the miner so both EXECUTEs land in the SAME block, which is the only
        // place the cross-action count applies.
        await regtestMinerConnector.pauseMining()
        let pairTx, singleTx
        try {
            await utxoTrackerConnector.requireSync()
            pairTx   = await vmHelper.sendExecuteV0Broadcast(operatorAddr, contractIndex, 'askPair', [])
            singleTx = await vmHelper.sendExecuteV0Broadcast(secondCaller, contractIndex, 'askOnce', [])
            await regtestMinerConnector.generateBlocks(1)
        } finally {
            await regtestMinerConnector.resumeMining()
        }
        assert(pairTx && singleTx, 'both EXECUTE transactions should broadcast')

        let pairRow   = await waitForAnyExecution(operatorAddr.address, 'askPair')
        let singleRow = await waitForAnyExecution(secondCaller.address, 'askOnce')
        assert(pairRow,   'askPair execution row should exist')
        assert(singleRow, 'askOnce execution row should exist')
        assert.strictEqual(Number(pairRow.block_index), Number(singleRow.block_index),
            'both EXECUTEs must share a block for the cross-action cap to apply')

        // Block order is the miner's. Pair-first: pair admits 2, single finds the share
        // full and reverts. Single-first: single admits 1, pair's second request trips
        // the cap and the whole pair reverts. Either way exactly one succeeds and the
        // other names the cap.
        let winners = [pairRow, singleRow].filter(r => r.status === 'valid')
        let losers  = [pairRow, singleRow].filter(r => r.status !== 'valid')
        assert.strictEqual(winners.length, 1, 'exactly one of the two same-block EXECUTEs should be admitted, got statuses: '
            + pairRow.status + ' / ' + singleRow.status)
        assertCapRevert(losers[0], losers[0].method_name)

        let admitted = await admittedInBlock(pairRow.block_index)
        assert(admitted >= 1 && admitted <= PER_CONTRACT_CAP,
            'admitted requests in the block must stay within the per-contract cap, got ' + admitted)
        assert.strictEqual(admitted, Number(winners[0].emitted_count),
            'the pending pool should hold exactly the winner\'s emissions')
    })
})
