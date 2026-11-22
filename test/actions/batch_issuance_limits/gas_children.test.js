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



const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const gasHelper = require('../../helpers/gasHelper')
const batchHelper = require('../../helpers/batchHelper')
const {
    GAS_TICK, XCHAIN_PER_ISSUE, XCHAIN_PER_CHILD_ISSUE, state, debitsForTx, balanceOf,
    waitForIssueCount, issueCmd, sendGasPaidIssue
} = require('./lib/shared')

// ─── A6 ────────────────────────────────────────────────────────────────────

const N = 8
const K = 6

// seedGas=false so the balance is exactly what this test funds, not the
// 100 XCHAIN getNewFundedAddress hands out by default.
async function fundExactGasSource(){
    // The budget is what the LEDGER debits per child, the gas schedule EXACTLY.
    // An over-sized budget silently buys extra children, so the K boundary this
    // test pins stops being a boundary.
    const addr    = await cryptoHelper.getNewFundedAddress("BIL.A6", COIN, NETWORK, null, "legacy", 0, 1, false)
    const address = addr["address"]
    const parent  = "BILA6" + address.substring(address.length - 8)

    const budget = XCHAIN_PER_ISSUE + K * XCHAIN_PER_CHILD_ISSUE
    await gasHelper.ensureGasBalance(addr, budget)
    assert.strictEqual(Number(await balanceOf(address, GAS_TICK)), budget,
        "the source must start with exactly " + budget + " XCHAIN")

    // The parent ISSUE must also be gas-metered, so it is sent WITHOUT the
    // harness's automatic fee output rather than through issueHelper.
    await sendGasPaidIssue(addr, parent, "A6 parent")
    const afterParent = Number(await balanceOf(address, GAS_TICK))
    assert.strictEqual(afterParent, K * XCHAIN_PER_CHILD_ISSUE,
        "after the parent ISSUE the source must hold gas for exactly " + K + " children")
    return { addr, address, parent }
}

function assertKValid(issues){
    assert.strictEqual(issues.length, N, "every child gets its own record")
    const valid   = issues.filter(r => r.status === 'valid')
    const invalid = issues.filter(r => r.status !== 'valid')
    assert.strictEqual(valid.length, K, "exactly K=" + K + " children may be valid")
    assert.strictEqual(invalid.length, N - K)
    for (const row of invalid)
        assert.strictEqual(row.status, 'invalid: insufficient funds (FEE)',
            "a child beyond the gas budget fails on the fee, got " + row.status)
    return { valid, invalid }
}

async function assertKDebits(txHash, address){
    const debits = await debitsForTx(txHash, GAS_TICK)
    assert.strictEqual(debits.length, K, "exactly K gas debits")
    const spent = debits.reduce((s, d) => s + Number(d.amount), 0)
    assert.strictEqual(spent, K * XCHAIN_PER_CHILD_ISSUE, "K x ISSUE_SUBTOKEN debited")
    assert.strictEqual(Number(await balanceOf(address, GAS_TICK)), 0,
        "the gas budget is exhausted exactly, with no overdraft")
    return debits
}

async function exactlyKChildren(){
    if (!state.GAS_MODE) this.skip()   // gas debits are only consulted in gas mode

    const { addr, address, parent } = await fundExactGasSource()
    const commands = []
    for (let n = 1; n <= N; n++)
        commands.push(issueCmd(parent + ".g" + n, 100, 100, 1, "c"))

    const result = await batchHelper.sendBatch(addr, commands,
        { status: 'valid', skipNativeFeeInjection: true })
    assert(result.batch, "the batch itself is valid; the shortfall is per-command")

    const issues = await waitForIssueCount(result.txHash, N)
    const { valid, invalid } = assertKValid(issues)
    const debits = await assertKDebits(result.txHash, address)

    // Earlier siblings stand: this is the non-atomicity the spec documents.
    console.log("A6 txHash=" + result.txHash + " valid=" + valid.length +
        " invalid=" + invalid.length + " debits=" + debits.length +
        " statuses=" + JSON.stringify(issues.map(r => r.status)))
}

module.exports = function registerGasChildrenCases(){
    context('A6: gas for exactly K children', function registerA6Cases(){
        it('yields exactly K valid children and K debits from a batch of N', exactlyKChildren)
    })
}
