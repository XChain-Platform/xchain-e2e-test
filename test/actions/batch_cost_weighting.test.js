// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// BATCH_COST_WEIGHTING acceptance suite (spec acceptance tests A2-A5).
//
// The flag replaces the flat per-BATCH command cap with a budget over per-action COST
// WEIGHTS. Every case here is a PAIR - one batch AT the budget that lands, one over it
// that is refused - because a single rejection cannot distinguish "the budget stopped
// it" from "this batch shape never works on this stack".
//
// The weights under test are the landed table in xchain-indexer/src/actions/batch.js:
// budget 250, default weight 1, AIRDROP/DIVIDEND 25, DEPLOY/EXECUTE/XEXEC 30, and the
// per-action cap DEPLOY = 1 that survives BESIDE the weight.
//
// A4 and A5 also carry a CONTROL: the same command COUNT built from ordinary SENDs,
// which must land. Without it a rejection at 9 EXECUTEs or 11 AIRDROPs is equally
// explained by the count cap, and the count cap is not what is being tested.
//
// Fee lane: on a native-fee chain the whole batch draws one fee pool, so the at-budget
// ISSUE case attaches an output covering all 250 sub-commands rather than the helper's
// flat per-transaction fee. Every other case fits inside the flat fee.

const assert = require('assert')
const cryptoHelper = require('../helpers/core/cryptoHelper')
const batchHelper = require('../helpers/batchHelper')
const gasHelper = require('../helpers/gasHelper')
const envelopeHelper = require('../helpers/envelopeHelper')
const {
    WEIGHT_BUDGET, XCHAIN_PER_ISSUE, XCHAIN_PER_CHILD_ISSUE, CONTRACT, lane, initLane, actionsForTx, issueStatusesForTx, contractsForTx, waitForActionCount, satsPerXchain, issueCmd, deployCmd, wholeBatchFee, envelopeLane, log,
} = require('./batch_cost_weighting.test/support/shared')

// A2: every sub-command is a segwit-funded ISSUE with a dotted child chain.
function issueFamily(parent, children) {
    const commands = [ issueCmd(parent, 1000000, 1000000, 1000, "p") ]
    for (let n = 1; n <= children; n++)
        commands.push(issueCmd(parent + "." + n, 100, 100, 10, "c"))
    return commands
}

async function landsAtBudget() {
    // Segwit-funded: the envelope commit's inputs must be segwit (§3.5).
    const addr    = await cryptoHelper.getNewFundedAddress("BCW.A2.AT", COIN, NETWORK, null, "segwit", 0, 1)
    const address = addr["address"]
    const parent  = "BCWA" + address.substring(address.length - 8)

    const CHILDREN = WEIGHT_BUDGET - 1
    const commands = issueFamily(parent, CHILDREN)
    assert.strictEqual(commands.length, WEIGHT_BUDGET)

    // Overpayment is never rejected, and the exact-coverage boundary is not this
    // suite's subject: what is under test is that 250 weight-1 sub-commands are
    // admitted, so the fee must not be what decides the verdict.
    const nominal = XCHAIN_PER_ISSUE + CHILDREN * XCHAIN_PER_CHILD_ISSUE
    const sats    = lane.feeDest ? (await satsPerXchain()) * nominal * 1.5 : 0

    const result = await batchHelper.sendBatch(addr, commands,
        Object.assign({ status: 'valid', timeout: 300000 }, wholeBatchFee(sats), envelopeLane(addr)))
    assert(result.batch, 'a 250-command batch of weight-1 sub-commands must be valid')
    assert.strictEqual(result.batch.status, 'valid')
    await log('A2 at-budget', result)
    await assertEveryIssueLanded(result)
}

async function assertEveryIssueLanded(result) {
    const actions = await waitForActionCount(result.txHash, WEIGHT_BUDGET + 1)
    assert.strictEqual(actions.length, WEIGHT_BUDGET + 1,
        'expected 1 BATCH + ' + WEIGHT_BUDGET + ' ISSUE action rows, got ' + actions.length)

    const issues = await issueStatusesForTx(result.txHash)
    assert.strictEqual(issues.length, WEIGHT_BUDGET, 'expected ' + WEIGHT_BUDGET + ' issue rows')
    assert.deepStrictEqual(
        issues.filter(r => r.status !== 'valid').map(r => r.tick + ' -> ' + r.status), [],
        'every issuance in an at-budget batch must land')
    console.log('A2 at-budget landed ' + issues.length + ' issuances in block ' + actions[0].block_index)
}

async function rejectsOverBudget() {
    const addr    = await cryptoHelper.getNewFundedAddress("BCW.A2.OVER", COIN, NETWORK, null, "segwit", 0, 1)
    const address = addr["address"]
    const parent  = "BCWB" + address.substring(address.length - 8)

    const commands = issueFamily(parent, WEIGHT_BUDGET)
    assert.strictEqual(commands.length, WEIGHT_BUDGET + 1)

    const result = await batchHelper.sendBatch(addr, commands,
        Object.assign({ status: 'invalid: COMMAND (limit)', timeout: 300000 }, envelopeLane(addr)))
    assert(result.batch, '251 weight-1 sub-commands must exceed the budget')
    assert.strictEqual(result.batch.status, 'invalid: COMMAND (limit)')
    await log('A2 over-budget', result)

    const actions = await actionsForTx(result.txHash)
    assert.strictEqual(actions.length, 1,
        'an over-budget BATCH is ONE record; no sub-command may execute (got ' +
        JSON.stringify(actions.map(a => a.action)) + ')')
    assert.strictEqual(actions[0].action, 'BATCH')
    assert.strictEqual((await issueStatusesForTx(result.txHash)).length, 0, 'no issue row')
}

async function admitsOneDeploy() {
    const addr = await cryptoHelper.getNewFundedAddress("BCW.A3.ONE", COIN, NETWORK, null, "legacy", 0, 1)
    await gasHelper.ensureGasBalance(addr, '100')

    const result = await batchHelper.sendBatch(addr, [ deployCmd(CONTRACT, 200000) ],
        { status: 'valid', timeout: 180000 })
    assert(result.batch, 'a batch carrying one DEPLOY must be valid')
    assert.strictEqual(result.batch.status, 'valid')
    await log('A3 one-deploy', result)

    const actions = await waitForActionCount(result.txHash, 2)
    assert.strictEqual(actions.length, 2, 'expected 1 BATCH + 1 DEPLOY action row')
    assert(actions.some(a => a.action === 'DEPLOY'), 'the DEPLOY sub-command must have run')
}

async function rejectsTwoDeploys() {
    const addr = await cryptoHelper.getNewFundedAddress("BCW.A3.TWO", COIN, NETWORK, null, "legacy", 0, 1)
    await gasHelper.ensureGasBalance(addr, '100')

    // Two DEPLOYs weigh 60 and count 2, so neither the budget nor the count cap can
    // explain this rejection: only the per-action cap of 1 can.
    const result = await batchHelper.sendBatch(addr,
        [ deployCmd(CONTRACT, 200000), deployCmd(CONTRACT, 200000) ],
        { status: 'invalid: DEPLOY (limit)', timeout: 180000 })
    assert(result.batch, 'two DEPLOYs must whole-batch reject')
    assert.strictEqual(result.batch.status, 'invalid: DEPLOY (limit)',
        'the per-action cap string must be unchanged by the weight table')
    await log('A3 two-deploys', result)

    const actions = await actionsForTx(result.txHash)
    assert.strictEqual(actions.length, 1,
        'a capped BATCH is ONE record (got ' + JSON.stringify(actions.map(a => a.action)) + ')')
    assert.strictEqual(actions[0].action, 'BATCH')
    assert.strictEqual((await contractsForTx(result.txHash)).length, 0, 'no contract row')
}

// Both A2 cases fund a SEGWIT source, because the envelope commit's inputs must
// all be segwit (§3.5). DOGE has no segwit at all, so p2wpkh cannot even be
// encoded there (bech32 throws on the absent network prefix) and the pair is
// unrunnable rather than failing. Same gate the envelope suites use.
function skipWithoutEnvelopes() {
    if (!envelopeHelper.envelopeSupported()) this.skip()
}

function describeA2() {
    beforeEach(skipWithoutEnvelopes)

    it('lands one parent plus 249 dotted children (weight 250, at budget)', landsAtBudget)

    it('rejects one parent plus 250 children with invalid: COMMAND (limit)', rejectsOverBudget)
}

function describeA3() {
    it('admits ONE DEPLOY (weight 30, far under budget)', admitsOneDeploy)

    it('rejects TWO DEPLOYs with invalid: DEPLOY (limit), not the budget', rejectsTwoDeploys)
}

describe('BATCH cost weighting (BATCH_COST_WEIGHTING)', function () {
    before(initLane)

    describe('A2: ordinary sub-commands still weigh 1 each', describeA2)

    describe('A3: the per-action DEPLOY cap survives beside the weight', describeA3)
})
