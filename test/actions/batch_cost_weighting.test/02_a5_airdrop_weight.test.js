// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A5: AIRDROP consumes its declared fan-out weight. Part of batch_cost_weighting.test.js.


const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const listHelper = require('../../helpers/listHelper')
const issueHelper = require('../../helpers/issueHelper')
const batchHelper = require('../../helpers/batchHelper')
const gasHelper = require('../../helpers/gasHelper')
const {
    FANOUT_WEIGHT, FANOUT_AT_BUDGET, FANOUT_OVER_BUDGET, actionsForTx, airdropStatusesForTx, waitForActionCount, sendCmd, airdropCmd, log,
} = require('./support/shared')

// A5 state, set up once by the before hook.
const st = { dropper: null, tick: null, listActionIndex: null }

async function issueDropToken() {
    st.dropper = await cryptoHelper.getNewFundedAddress("BCW.A5", COIN, NETWORK, null, "legacy", 0, 1)
    const address = st.dropper["address"]
    st.tick = "BCWD" + address.substring(address.length - 8)

    await gasHelper.ensureGasBalance(st.dropper, '500')
    await issueHelper.sendIssueV0(st.dropper, st.tick, 100000, 100000, 0, "A5 fan-out token", 100000)
}

async function createRecipientList() {
    const r1 = await cryptoHelper.getNewAddress("BCW.A5", COIN, NETWORK, null, "legacy", 1)
    const r2 = await cryptoHelper.getNewAddress("BCW.A5", COIN, NETWORK, null, "legacy", 2)
    const r3 = await cryptoHelper.getNewAddress("BCW.A5", COIN, NETWORK, null, "legacy", 3)
    const list = await listHelper.sendListV0(st.dropper, 2, [r1["address"], r2["address"], r3["address"]])
    assert(list.list, 'the A5 recipient list must exist')
    st.listActionIndex = Number(list.list["action_index"])
    console.log('A5 list action_index=' + st.listActionIndex + ' recipients=3')
}

async function setUpDropper() {
    await issueDropToken()
    await createRecipientList()
}

function airdropBatch(count, memoPrefix) {
    const commands = []
    for (let n = 0; n < count; n++)
        commands.push(airdropCmd(st.tick, 1, st.listActionIndex, memoPrefix + n))
    return commands
}

async function acceptsAtBudget() {
    const result = await batchHelper.sendBatch(st.dropper, airdropBatch(FANOUT_AT_BUDGET, "d"), { status: 'valid', timeout: 240000 })
    assert(result.batch, FANOUT_AT_BUDGET + ' AIRDROPs weigh exactly the budget and must be admitted')
    assert.strictEqual(result.batch.status, 'valid')
    await log('A5 at-budget', result)

    const actions = await waitForActionCount(result.txHash, FANOUT_AT_BUDGET + 1)
    assert.strictEqual(actions.length, FANOUT_AT_BUDGET + 1,
        'expected 1 BATCH + ' + FANOUT_AT_BUDGET + ' AIRDROP action rows, got ' + actions.length)

    const airdrops = await airdropStatusesForTx(result.txHash)
    assert.strictEqual(airdrops.length, FANOUT_AT_BUDGET,
        'expected ' + FANOUT_AT_BUDGET + ' airdrop rows, got ' + airdrops.length)
    assert.deepStrictEqual(
        airdrops.filter(r => r.status !== 'valid').map(r => r.action_index + ' -> ' + r.status), [],
        'every AIRDROP in an at-budget batch must land')
    console.log('A5 at-budget landed ' + airdrops.length + ' airdrops in block ' + actions[0].block_index)
}

async function rejectsOverBudget() {
    const result = await batchHelper.sendBatch(st.dropper, airdropBatch(FANOUT_OVER_BUDGET, "e"),
        { status: 'invalid: COMMAND (limit)', timeout: 240000 })
    assert(result.batch, FANOUT_OVER_BUDGET + ' AIRDROPs exceed the budget on fan-out weight alone')
    assert.strictEqual(result.batch.status, 'invalid: COMMAND (limit)')
    await log('A5 over-budget', result)

    const actions = await actionsForTx(result.txHash)
    assert.strictEqual(actions.length, 1,
        'the whole batch is ONE record, not ' + FANOUT_OVER_BUDGET + ' rejected AIRDROPs (got ' +
        JSON.stringify(actions.map(a => a.action)) + ')')
    assert.strictEqual(actions[0].action, 'BATCH')
    assert.strictEqual((await airdropStatusesForTx(result.txHash)).length, 0, 'no airdrop row')
}

async function controlOrdinaryCommandsLand() {
    const dest = await cryptoHelper.getNewAddress("BCW.A5", COIN, NETWORK, null, "legacy", 4)

    const commands = []
    for (let n = 0; n < FANOUT_OVER_BUDGET; n++) commands.push(sendCmd(st.tick, 1, dest["address"]))

    const result = await batchHelper.sendBatch(st.dropper, commands, { status: 'valid', timeout: 180000 })
    assert(result.batch,
        FANOUT_OVER_BUDGET + ' weight-1 sub-commands must land; only AIRDROP\'s fan-out weight refuses the batch above')
    assert.strictEqual(result.batch.status, 'valid')
    await log('A5 control', result)
}

describe('BATCH cost weighting (BATCH_COST_WEIGHTING)', function () {
    describe('A5: AIRDROP consumes its declared fan-out weight of ' + FANOUT_WEIGHT, function () {
        before(setUpDropper)

        it('accepts ' + FANOUT_AT_BUDGET + ' AIRDROPs (weight ' + (FANOUT_AT_BUDGET * FANOUT_WEIGHT) + ', exactly the budget)', acceptsAtBudget)

        it('rejects ' + FANOUT_OVER_BUDGET + ' AIRDROPs as ONE invalid record', rejectsOverBudget)

        it('control: ' + FANOUT_OVER_BUDGET + ' ordinary sub-commands at the same count land', controlOrdinaryCommandsLand)
    })
})
