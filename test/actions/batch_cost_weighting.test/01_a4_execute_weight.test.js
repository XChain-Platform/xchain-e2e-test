// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A4: EXECUTE weighs 30. Part of batch_cost_weighting.test.js.


const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const issueHelper = require('../../helpers/issueHelper')
const batchHelper = require('../../helpers/batchHelper')
const gasHelper = require('../../helpers/gasHelper')
const vmHelper = require('../../helpers/vmHelper')
const {
    VM_WEIGHT, VM_AT_BUDGET, VM_OVER_BUDGET, CONTRACT, actionsForTx, executionStatusesForTx, waitForActionCount, sendCmd, executeCmd, log,
} = require('./support/shared')

// A4 state, set up once by the before hook.
const st = { deployer: null, contractIndex: null }

async function deployCounter() {
    st.deployer = await cryptoHelper.getNewFundedAddress("BCW.A4", COIN, NETWORK, null, "legacy", 0, 1)
    await gasHelper.ensureGasBalance(st.deployer, '500')
    const deploy = await vmHelper.sendDeployV0(st.deployer, CONTRACT, 200000, 'init')
    assert(deploy.contract, 'the A4 contract must deploy')
    st.contractIndex = deploy.contract.action_index
    console.log('A4 contract action_index=' + st.contractIndex + ' txHash=' + deploy.txHash)
}

function executeBatch(count) {
    const commands = []
    for (let n = 0; n < count; n++) commands.push(executeCmd(st.contractIndex, 'bump'))
    return commands
}

async function acceptsAtBudget() {
    const result = await batchHelper.sendBatch(st.deployer, executeBatch(VM_AT_BUDGET), { status: 'valid', timeout: 240000 })
    assert(result.batch, VM_AT_BUDGET + ' EXECUTEs must be inside the budget')
    assert.strictEqual(result.batch.status, 'valid')
    await log('A4 at-budget', result)

    const actions = await waitForActionCount(result.txHash, VM_AT_BUDGET + 1)
    assert.strictEqual(actions.length, VM_AT_BUDGET + 1,
        'expected 1 BATCH + ' + VM_AT_BUDGET + ' EXECUTE action rows, got ' + actions.length)

    const executions = await executionStatusesForTx(result.txHash)
    assert.strictEqual(executions.length, VM_AT_BUDGET,
        'expected ' + VM_AT_BUDGET + ' execution rows, got ' + executions.length)
    assert.deepStrictEqual(
        executions.filter(r => r.status !== 'valid').map(r => r.action_index + ' -> ' + r.status), [],
        'every EXECUTE in an at-budget batch must run')
    console.log('A4 at-budget ran ' + executions.length + ' executions in block ' + actions[0].block_index)
}

async function rejectsOverBudget() {
    const result = await batchHelper.sendBatch(st.deployer, executeBatch(VM_OVER_BUDGET),
        { status: 'invalid: COMMAND (limit)', timeout: 240000 })
    assert(result.batch, VM_OVER_BUDGET + ' EXECUTEs must exceed the budget')
    assert.strictEqual(result.batch.status, 'invalid: COMMAND (limit)')
    await log('A4 over-budget', result)

    const actions = await actionsForTx(result.txHash)
    assert.strictEqual(actions.length, 1,
        'the whole batch is ONE record, not ' + VM_OVER_BUDGET + ' rejected EXECUTEs (got ' +
        JSON.stringify(actions.map(a => a.action)) + ')')
    assert.strictEqual(actions[0].action, 'BATCH')
    assert.strictEqual((await executionStatusesForTx(result.txHash)).length, 0, 'no execution row')
}

async function controlOrdinaryCommandsLand() {
    const addr    = await cryptoHelper.getNewFundedAddress("BCW.A4.CTL", COIN, NETWORK, null, "legacy", 0, 1)
    const address = addr["address"]
    const tick    = "BCWC" + address.substring(address.length - 8)
    const dest    = await cryptoHelper.getNewAddress("BCW.A4.CTL", COIN, NETWORK, null, "legacy", 1)

    await gasHelper.ensureGasBalance(addr, '100')
    await issueHelper.sendIssueV0(addr, tick, 1000, 1000, 0, "A4 control", 1000)

    const commands = []
    for (let n = 0; n < VM_OVER_BUDGET; n++) commands.push(sendCmd(tick, 1, dest["address"]))

    const result = await batchHelper.sendBatch(addr, commands, { status: 'valid', timeout: 180000 })
    assert(result.batch,
        VM_OVER_BUDGET + ' weight-1 sub-commands must land; only EXECUTE\'s weight refuses the batch above')
    assert.strictEqual(result.batch.status, 'valid')
    await log('A4 control', result)
}

describe('BATCH cost weighting (BATCH_COST_WEIGHTING)', function () {
    describe('A4: EXECUTE weighs ' + VM_WEIGHT, function () {
        before(deployCounter)

        it('accepts ' + VM_AT_BUDGET + ' EXECUTEs (weight ' + (VM_AT_BUDGET * VM_WEIGHT) + ')', acceptsAtBudget)

        it('rejects ' + VM_OVER_BUDGET + ' EXECUTEs as ONE invalid record', rejectsOverBudget)

        it('control: ' + VM_OVER_BUDGET + ' ordinary sub-commands at the same count land', controlOrdinaryCommandsLand)
    })
})
