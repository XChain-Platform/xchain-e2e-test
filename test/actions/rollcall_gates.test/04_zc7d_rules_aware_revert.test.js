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
 ********************************************************************/

// ZC7d: with fewer surviving sources than REDUNDANCY the emitting EXECUTE reverts with the rules-aware literal. Part of rollcall_gates.test.js.

'use strict'

const assert = require('assert')

const rc = require('../../helpers/rollcallHelper')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const gasHelper = require('../../helpers/gasHelper')
const vmHelper = require('../../helpers/vmHelper')
const { capabilitySet } = require('./support/shared')

// Deliberately short: these requests are never meant to be answered.
const DEADLINE_BLOCKS = 10

// Buries the close, confirms the filtered set is short and funds the operator.
async function prepareOperator(st){
    const { ctx, C2, E2, redundancy, sourcesBefore, httpGet } = st
    assert.ok(redundancy, 'ZC7d emits the redundancy ZC7b sized; this suite runs in file order')

    // The filter reads the most recent ROLLED epoch whose close is at or below
    // the request's BURIED block (D92), and ZC7c leaves the tip at C2 + 2, so a
    // request mined now would be judged on E1's full lists and the pre-read at
    // tip - 6 would say the same: measured 2026-09-08, "1 qualifying source(s)
    // survive against redundancy 1" with ZC7c green a moment earlier. Bury E2's
    // close first so both the pre-read and the request block see its rows.
    await rc.mineBtcTo(ctx, C2 + 7, 'burying the close of epoch ' + E2 + ' so a request block reads its gates rows')

    const tip = await ctx.btcTip()
    const after = await capabilitySet('attestation', tip - 6, httpGet.min_stake_xchain)
    assert.ok(after.sources.size < redundancy,
        'ZC7d needs the filtered set to be SHORT of the request\'s redundancy: ' + after.sources.size +
        ' qualifying source(s) survive at the http_get floor against redundancy ' + redundancy + '. ZC7b ' +
        'sized this from ' + sourcesBefore + ' source(s) before the drop, so a set this large means stake ' +
        'moved during the run.')
    assert.ok(redundancy <= sourcesBefore,
        'ZC7d\'s request must be one the venue could have served before the filter ran, or the refusal says ' +
        'nothing about the rules')

    const operator = await cryptoHelper.getNewFundedAddress(
        'zc7-operator', COIN, NETWORK, null, 'legacy', 0, 0.02)
    // DEPLOY gas plus one EXECUTE that pays full metered gas for a reverted
    // tree: a failed execution is not refunded.
    await gasHelper.ensureGasBalance(operator, '20000')
    await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })
    return operator
}

async function deployAsker(st, operator){
    const { ctx, redundancy } = st
    // The redundancy is baked in at deploy time because it is measured, not
    // chosen: the contract is written after ZC7b has counted the venue.
    const code = `
module.exports = {
    meta: { name: 'Rollcall Asker', description: 'Requests an attestation and records a marker for the roll-call gate drill.', version: '1.0.0' },
    ask: function(xchain) {
        xchain.state.set('zc7_marker', xchain.getInputParam(0));
        xchain.attestation.request('http_get', 'https://example.com/zc7/' + xchain.getInputParam(0),
            'handleResponse', ['ctx-zc7'], { redundancy: ${redundancy}, deadlineBlocks: ${DEADLINE_BLOCKS} });
        return 'asked';
    },
    handleResponse: function(xchain) { xchain.state.set('zc7_callback', xchain.getInputParam(2)); }
};
`
    const deploy = await rc.mineWhile(ctx, () => vmHelper.sendDeployV0(operator, code, 500000))
    assert.strictEqual(deploy.contract.status, 'valid', 'deploy status: ' + deploy.contract.status)
    const contractIndex = deploy.contract.action_index
    return contractIndex
}

async function assertRulesAwareRevert(st, operator, contractIndex){
    const { ctx, redundancy } = st
    const exec = await rc.mineWhile(ctx,
        () => vmHelper.sendExecuteV0Invalid(operator, contractIndex, 'ask', ['rules'], 120000))
    assert.ok(exec.execution, 'the refused EXECUTE must still be recorded on-chain')
    assert.notStrictEqual(exec.execution.status, 'valid',
        'a refused ATTEST v0 emission must not leave the EXECUTE valid: processEmission throws on a ' +
        'non-valid emission and the savepoint rolls back')

    const why = String(exec.execution.error_message || '')
    console.log('    ZC7d EXECUTE status=' + exec.execution.status + ' error_message=' + why)
    // THE LITERAL, and it is the point of the leg. Two refusals share this gate
    // and they mean different things to an operator: "the set was always this
    // small" is a staking problem nobody can act on, while "the rules filter
    // shrank it" names a fleet that has not rolled a call covering the gates
    // active at this block. The rules-aware branch is reachable ONLY when the
    // filter actually dropped somebody at the request block, which is why
    // matching it here is a measurement of the filter and not of the string.
    const m = why.match(/invalid: REDUNDANCY \(rules-aware set (\d+) < (\d+) at request block\)/)
    assert.ok(m,
        'ZC7d: the refusal must carry the RULES-AWARE literal, got: ' + why + '\nThe generic ' +
        '"responsible set N < M" literal here would mean the filter dropped nobody at the request block and ' +
        'the set was short for an ordinary staking reason.')
    assert.strictEqual(Number(m[2]), redundancy,
        'the literal must name the request\'s own redundancy, got ' + m[2])
    assert.ok(Number(m[1]) < redundancy,
        'the literal must name a surviving set smaller than the redundancy, got ' + m[1])

    // The revert, stated as rows: a v0 exists only as a VM emission, so no ATTEST
    // row survives and neither does the state write that ran before it.
    const stored = await indexerDatabase.getAttestationRequestsByContract(contractIndex)
    assert.strictEqual(stored.length, 0,
        'ZC7d: a refused request is never stored, not even as `rejected`: found ' + stored.length + ' row(s)')
    const marker = await indexerDatabase.getContractState(contractIndex, 'zc7_marker')
    assert.strictEqual(marker, null,
        'ZC7d: the reverted EXECUTE must leave no contract state behind, which is what a contract author ' +
        'actually sees when the fleet has not rolled a call covering this block\'s rules')
}

async function revertsWithRulesAwareLiteral(st){
    const operator = await prepareOperator(st)
    const contractIndex = await deployAsker(st, operator)
    await assertRulesAwareRevert(st, operator, contractIndex)
}

function register(st){
    it('ZC7d: with fewer surviving sources than REDUNDANCY the emitting EXECUTE reverts with the rules-aware literal', async function () { await revertsWithRulesAwareLiteral(st) })
}

module.exports = { register }
