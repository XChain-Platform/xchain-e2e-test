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
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')
const vmHelper = require('../helpers/vmHelper')
const batchHelper = require('../helpers/batchHelper')
const attestationHelper = require('../helpers/attestationHelper')
const capRule = require('../../../xchain-indexer/src/attest_request_cap_activation.js')

/**
 * ATTEST v0 per-block admission caps, driven on a chain.
 *
 * The caps (framework spec §11.1, xchain-indexer
 * src/attest_request_cap_activation.js) bound how many attestation requests one
 * block may admit: `perContract` 2 from any single contract, `perBlock` 10 in
 * total. They exist because an ADMITTED request makes OTHER people spend - each
 * one puts REDUNDANCY validators on the hook for a provider call, and for the
 * `llm` provider that is a real invoice - while the requester pays the same flat
 * VM_ATTEST_REQUEST gas either way. They were armed at genesis on regtest and
 * testnet and then never observed refusing anything on a live chain: measured
 * 2026-09-02, no block of the BTC regtest venue had ever carried more than ONE
 * ATTEST v0, so the gate had never been reached, only unit-tested against a
 * stubbed count.
 *
 * This suite reaches it, and pins what a live over-cap request actually does.
 *
 * WHAT IT DOES IS NOT WHAT THE CAP'S OWN DESIGN NOTE PROMISED, which is the
 * finding worth keeping in front of a reader. The note describes a per-request
 * refusal: an over-cap request "REJECTED ('rejected' request_status, terminal at
 * creation, fee never escrowed)", with the author's remedy being to retry in a
 * later block. Live, the refusal is a WHOLE-EXECUTE REVERT: attest.js records
 * the rejection on the emission's data, execute.js processEmission sees a
 * non-'valid' emission status and throws, the emitting EXECUTE's savepoint rolls
 * back, and NOTHING of that execution survives - not the over-cap request, not
 * the under-cap siblings admitted moments earlier in the same transaction, not
 * the contract's state writes. The EXECUTE lands 'failed' carrying the cap's own
 * message in error_message, and that message is the ONLY durable trace of the
 * refusal. Every ATTEST v0 admission rule behaves this way (a v0 exists only as
 * a VM emission), so no ATTEST v0 row can ever be stored 'rejected'.
 *
 * That distinction is the whole point of driving it: it decides what a contract
 * author sees (a dead transaction, not a rejected callback), and it decides
 * whether a block's admitted requests can be destroyed by a rule that fires
 * after them.
 */

describe('Attestation admission caps: an over-cap ATTEST v0 refusal on a live chain', function () {

    // Short window: these requests are never meant to be answered, and a shorter
    // deadline lets the expiry sweep retire them promptly instead of leaving the
    // venue's pending pool full for the rest of the run.
    const DEADLINE_BLOCKS = 5
    const REDUNDANCY      = 1

    let operatorAddr  = null
    let contractIndex = null

    const CONTRACT_CODE = `
module.exports = {
    askTwo: function(xchain) {
        var tag = xchain.getInputParam(0);
        xchain.state.set('two_marker', tag);
        xchain.attestation.request('http_get', 'https://example.com/cap/' + tag + '/a',
            'handleResponse', ['ctx-cap'], { redundancy: ${REDUNDANCY}, deadlineBlocks: ${DEADLINE_BLOCKS} });
        xchain.attestation.request('http_get', 'https://example.com/cap/' + tag + '/b',
            'handleResponse', ['ctx-cap'], { redundancy: ${REDUNDANCY}, deadlineBlocks: ${DEADLINE_BLOCKS} });
        return 'two';
    },
    askThree: function(xchain) {
        var tag = xchain.getInputParam(0);
        xchain.state.set('three_marker', tag);
        xchain.attestation.request('http_get', 'https://example.com/cap/' + tag + '/a',
            'handleResponse', ['ctx-cap'], { redundancy: ${REDUNDANCY}, deadlineBlocks: ${DEADLINE_BLOCKS} });
        xchain.attestation.request('http_get', 'https://example.com/cap/' + tag + '/b',
            'handleResponse', ['ctx-cap'], { redundancy: ${REDUNDANCY}, deadlineBlocks: ${DEADLINE_BLOCKS} });
        xchain.attestation.request('http_get', 'https://example.com/cap/' + tag + '/c',
            'handleResponse', ['ctx-cap'], { redundancy: ${REDUNDANCY}, deadlineBlocks: ${DEADLINE_BLOCKS} });
        return 'three';
    },
    handleResponse: function(xchain) {
        xchain.state.set('cap_callback_status', xchain.getInputParam(2));
    }
};
`

    before(async function () {
        // ATTEST rides on STAKE + EXECUTE, both BTC-only protocol features.
        if (COIN_CODE !== 'BTC') {
            console.log('Attestation admission caps require the BTC chain; skipping on ' + COIN_CODE)
            this.skip()
            return
        }
        // The gate under test must actually be armed on this venue, or the suite
        // would assert an admission that nothing was ever going to refuse.
        assert.ok(capRule.isAttestRequestCapActive(0, NETWORK),
            'the ATTEST request cap is inert on network "' + NETWORK + '"; there is no cap to drive')
        assert.strictEqual(capRule.ATTEST_REQUEST_CAPS.perContract, 2,
            'this suite drives the per-contract cap by emitting 3 requests; it must be 2')

        operatorAddr = await cryptoHelper.getNewFundedAddress(
            'attest-cap-op', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        // DEPLOY gas + two EXECUTEs, one of which pays full metered gas for a
        // failed tree (no refunds on a reverted execution).
        await gasHelper.ensureGasBalance(operatorAddr, '20000')

        // A request whose responsible set is smaller than its REDUNDANCY is refused by
        // the ADMISSION gate, which sits directly ABOVE the cap and would refuse every
        // request here before the cap was ever consulted. One staked attestation
        // validator, from its own source, is what makes redundancy=1 servable.
        const validator = new attestationHelper.MockAttestationValidator()
        const stakeSource = await cryptoHelper.getNewFundedAddress(
            'attest-cap-val', COIN, NETWORK, null, 'legacy', 0, 0.02
        )
        // 15000 clears both the attestation capability floor (1000) and the http_get
        // provider floor (10000) the stake-weighted path enforces.
        await gasHelper.ensureGasBalance(stakeSource, '20000')
        await stakeHelper.sendStakeV1(stakeSource, '15000.00000000', validator.pubkey)
        validator.source = stakeSource.address
        // Session-wide registration: later suites mirror the indexer's responsible-set
        // ranking over every key staked on this chain, not just their own.
        attestationHelper.registerStakedValidator(validator)
        await regtestMinerConnector.generateBlocks(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS)
        // The encoder refuses UTXO selection while the tracker trails the node, so the
        // next tx build races those blocks unless the tracker is caught up first.
        await utxoTrackerConnector.waitForSync()

        const deploy = await vmHelper.sendDeployV0(operatorAddr, CONTRACT_CODE, 500000)
        assert.strictEqual(deploy.contract.status, 'valid', 'deploy status: ' + deploy.contract.status)
        contractIndex = deploy.contract.action_index
    })

    it('admits a contract\'s full per-contract share in one block', async function () {
        const exec = await vmHelper.sendExecuteV0(operatorAddr, contractIndex, 'askTwo', ['under'])
        assert.strictEqual(exec.execution.status, 'valid', 'execute status: ' + exec.execution.status)

        const rows = await indexerDatabase.waitForAttestationRequestCount({
            contractIndex: contractIndex, count: 2
        })
        assert(rows, 'both ATTEST v0 rows of the under-cap EXECUTE should be stored')
        assert.strictEqual(rows.length, 2, 'exactly the two requested admissions, got ' + rows.length)

        // Both in ONE block, which is the only arrangement the cap counts over: the
        // count is taken at (this block, action_index < mine), so two requests split
        // across blocks would never test it.
        assert.strictEqual(Number(rows[0].block_index), Number(rows[1].block_index),
            'both requests must land in the same block for the cap to be under test')
        assert.ok(Number(rows[0].action_index) < Number(rows[1].action_index),
            'emissions must be ordered by action_index; the cap counts on that order')

        for (const row of rows) {
            assert.strictEqual(row.status, 'valid', 'an under-cap request must be admitted, got: ' + row.status)
            assert.notStrictEqual(row.request_status, 'rejected',
                'an under-cap request must not be refused')
        }

        // The second admission proves the count query saw the first one: with the
        // counter blind, byContract would have read 0 for both.
        this.test.parent.ctx.admittedBlock = Number(rows[0].block_index)
    })

    it('refuses the third, and the refusal fails the whole EXECUTE rather than storing a rejected row', async function () {
        const before = await indexerDatabase.getAttestationRequestsByContract(contractIndex)
        assert.strictEqual(before.length, 2, 'precondition: the contract starts this test with its 2 admitted rows')

        const exec = await vmHelper.sendExecuteV0Invalid(operatorAddr, contractIndex, 'askThree', ['over'])
        assert(exec.execution, 'the over-cap EXECUTE must still be recorded on-chain')
        assert.notStrictEqual(exec.execution.status, 'valid',
            'an over-cap ATTEST emission must not leave the EXECUTE valid')

        // The cap's own message, carried verbatim from attest.js through
        // processEmission's throw onto the execution row. This string IS the
        // observation the ledger asked for: the rule fired on a live chain.
        const why = String(exec.execution.error_message || '')
        console.log('  over-cap EXECUTE status=' + exec.execution.status + ' error_message=' + why)
        assert.match(why, /ATTEST cap/,
            'the failure must name the admission cap, got: ' + why)
        assert.match(why, /contract already has 2 request\(s\) this block, max 2/,
            'the failure must name the per-contract cap it hit, got: ' + why)

        // The revert, stated as rows. Nothing of the failed EXECUTE survives: not the
        // over-cap request (so no ATTEST v0 is ever stored 'rejected'), and not the two
        // UNDER-cap siblings it emitted before the third, which had already been
        // admitted when the third was refused.
        const after = await indexerDatabase.getAttestationRequestsByContract(contractIndex)
        assert.strictEqual(after.length, 2,
            'the failed EXECUTE must leave no ATTEST v0 rows behind, found ' + (after.length - 2) + ' extra')
        for (const row of after) {
            assert.strictEqual(Number(row.block_index), this.test.parent.ctx.admittedBlock,
                'the only surviving requests must be the earlier block\'s admitted pair')
        }

        // Same revert, seen from the contract's side: the state write that ran BEFORE
        // the first request of the failed EXECUTE is gone too.
        const marker = await indexerDatabase.getContractState(contractIndex, 'three_marker')
        assert.strictEqual(marker, null,
            'the reverted EXECUTE must not leave contract state behind')
        const kept = await indexerDatabase.getContractState(contractIndex, 'two_marker')
        assert(kept, 'the earlier successful EXECUTE\'s state write must survive')
        assert.strictEqual(JSON.parse(kept.state_value), 'under')
    })

    /**
     * The OTHER cap, and the one that actually bounds validator spend: the
     * network-wide ceiling on how many requests a single block may admit at all.
     *
     * It cannot be reached from one contract, because the per-contract share (2)
     * binds first, so reaching it needs `perBlock / perContract` = 5 contracts
     * admitting their full share inside ONE block, plus a sixth to be refused.
     * A BATCH puts all six in one transaction, and therefore one block, while
     * leaving every EXECUTE a ROOT action: subcommands are dispatched in list
     * order, each with its own action_index, and a subcommand that fails does not
     * fail the batch, so the ten admissions ahead of the refusal SURVIVE. That is
     * what makes this the one arrangement where the ceiling can be seen doing its
     * job rather than merely reported: ten stored requests, and an eleventh that
     * is not.
     *
     * (The obvious alternative, one dispatcher making five cross-contract calls,
     * does not work today: an ATTEST v0 emitted from a NESTED execution is refused
     * with `invalid: REQUEST_ID (does not match deterministic derivation)`, so the
     * first filler dies before the block is anywhere near full. Measured on BTC
     * regtest 2026-09-02; it is a defect in the request_id derivation for
     * emit.execute callees, unrelated to the caps, and it is why this is a BATCH.)
     */
    describe('the network-wide block ceiling', function () {

        // 5 contracts x perContract 2 fills the block to the ceiling; the 6th is
        // the one the ceiling has to refuse.
        const FILLERS = 6

        const fillerIndexes = []

        // Deployed FILLERS times. The block comment differs per copy so no two
        // fillers share contract code, which keeps them distinguishable in any
        // by-code lookup; the behaviour is identical.
        const fillerCode = (n) => `
// filler ${n}
module.exports = {
    askTwo: function(xchain) {
        xchain.attestation.request('http_get', 'https://example.com/ceiling/${n}/a',
            'noop', ['ctx-fill'], { redundancy: ${REDUNDANCY}, deadlineBlocks: ${DEADLINE_BLOCKS} });
        xchain.attestation.request('http_get', 'https://example.com/ceiling/${n}/b',
            'noop', ['ctx-fill'], { redundancy: ${REDUNDANCY}, deadlineBlocks: ${DEADLINE_BLOCKS} });
    },
    noop: function(xchain) { xchain.state.set('noop', '1'); }
};
`

        before(async function () {
            if (COIN_CODE !== 'BTC') { this.skip(); return }
            assert.strictEqual(capRule.ATTEST_REQUEST_CAPS.perBlock, 10,
                'this suite fills a block with 5 x 2 requests; perBlock must be 10')

            for (let n = 0; n < FILLERS; n++) {
                const deploy = await vmHelper.sendDeployV0(operatorAddr, fillerCode(n), 500000)
                assert.strictEqual(deploy.contract.status, 'valid',
                    'filler ' + n + ' deploy status: ' + deploy.contract.status)
                fillerIndexes.push(deploy.contract.action_index)
            }
        })

        it('admits exactly ten requests in one block and refuses the eleventh', async function () {
            const batch = await batchHelper.sendBatchV0(operatorAddr,
                fillerIndexes.map(i => 'EXECUTE|0|' + i + '|askTwo'))
            assert(batch.batch, 'the BATCH itself must be valid: one refused subcommand does not fail it')

            // The last FILLING subcommand's pair is the marker that the whole
            // ten-request prefix has been indexed.
            const lastFilled = await indexerDatabase.waitForAttestationRequestCount({
                contractIndex: fillerIndexes[4], count: 2
            })
            assert(lastFilled, 'the fifth contract\'s pair should complete the block ceiling')

            let admitted = 0
            let block = null
            for (let n = 0; n < 5; n++) {
                const rows = await indexerDatabase.getAttestationRequestsByContract(fillerIndexes[n])
                assert.strictEqual(rows.length, 2, 'filler ' + n + ' should have admitted its full share')
                for (const row of rows) {
                    assert.strictEqual(row.status, 'valid', 'filler ' + n + ': ' + row.status)
                    if (block === null) block = Number(row.block_index)
                    assert.strictEqual(Number(row.block_index), block,
                        'every admission must be in ONE block or the ceiling is not under test')
                    admitted++
                }
            }
            assert.strictEqual(admitted, capRule.ATTEST_REQUEST_CAPS.perBlock,
                'the block must be filled to exactly the ceiling before the refusal')

            // The sixth contract has requested nothing, so its per-contract share is
            // untouched: the block ceiling is the only rule that can refuse it, which
            // is what makes this an unambiguous reading of that branch.
            const refused = await indexerDatabase.waitForExecution({
                contractIndex: fillerIndexes[5], caller: operatorAddr.address, methodName: 'askTwo'
            })
            assert(refused, 'the sixth subcommand must be recorded on-chain')
            const why = String(refused.error_message || '')
            console.log('  ceiling EXECUTE status=' + refused.status + ' error_message=' + why)
            assert.notStrictEqual(refused.status, 'valid',
                'the refused subcommand must not read valid')
            assert.match(why, /block already has 10 request\(s\), max 10/,
                'the failure must name the per-BLOCK ceiling, not the per-contract share, got: ' + why)

            const none = await indexerDatabase.getAttestationRequestsByContract(fillerIndexes[5])
            assert.strictEqual(none.length, 0, 'the refused request must not be stored')

            // A failed subcommand is scoped to itself: the ten admissions in the same
            // transaction, made by other contracts, survive it. That is the difference
            // between BATCH and the emission tree, where a refusal takes its siblings
            // down with it.
            const survivors = await indexerDatabase.getAttestationRequestsByContract(fillerIndexes[0])
            assert.strictEqual(survivors.length, 2,
                'the earlier subcommands\' admissions must survive a later one\'s refusal')
        })
    })
})
