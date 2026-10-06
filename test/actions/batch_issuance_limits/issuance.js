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
const batchHelper = require('../../helpers/batchHelper')
const { prepareFeeFixture, restoreFeeFixture, feeOutput } = require('./fee_fixture')
const {
    GAS_TICK, XCHAIN_PER_ISSUE, XCHAIN_PER_CHILD_ISSUE, state, debitsForTx, tokenRow,
    feesForTx, balanceOf, waitForActionCount, waitForIssueCount, issueCmd
} = require('./shared')

module.exports = function registerIssuanceCases(){

    // ─── A1 ────────────────────────────────────────────────────────────────────
    describe('A1: one parent plus 50 children in ONE transaction', function () {
        after(async function () {
            // The native lane below re-prices the shared pair on dust-heavy chains;
            // A2/A3 run next and rely on the standard fixture.
            await restoreFeeFixture()
        })

        it('lands 51 valid actions, every child owned by the issuer', async function () {
            const addr    = await cryptoHelper.getNewFundedAddress("BIL.A1", COIN, NETWORK, null, "legacy", 0, 1)
            const address = addr["address"]
            const parent  = "BILA1" + address.substring(address.length - 8)

            const CHILDREN = 50
            const commands = [ issueCmd(parent, 1000000, 1000000, 1000, "p") ]
            for (let n = 1; n <= CHILDREN; n++)
                commands.push(issueCmd(parent + "." + n, 100, 100, 10, "c"))

            // Both lanes, because the two say different things. In GAS mode the batch
            // carries no fee output and the per-command schedule is directly readable
            // off the ledger. In NATIVE mode the same 51 commands draw on ONE fee pool,
            // so this is also the scale check on R5: 51 legitimate commands with the
            // fee covered must all stand. The output is deliberately generous (the
            // exact-coverage boundary is A4's job, and overpayment is never rejected);
            // what is under test here is that the pool does not starve a valid batch.
            const totalXchain = XCHAIN_PER_ISSUE + CHILDREN * XCHAIN_PER_CHILD_ISSUE
            let sendOpts = { status: 'valid', skipNativeFeeInjection: true }
            if (!state.GAS_MODE){
                const wholeBatchSats = await prepareFeeFixture(totalXchain)
                sendOpts = { status: 'valid', skipNativeFeeInjection: false,
                             customOutputs: feeOutput(Math.ceil(wholeBatchSats * 1.5)) }
            }

            const gasBefore = await balanceOf(address, GAS_TICK)
            const result = await batchHelper.sendBatch(addr, commands, sendOpts)
            assert(result.batch, "the 51-command BATCH should be valid")
            console.log("A1 txHash=" + result.txHash + " batch action_index=" + result.batch.action_index)

            // 51 sub-commands + the BATCH itself.
            const actions = await waitForActionCount(result.txHash, 52)
            assert.strictEqual(actions.length, 52,
                "expected 1 BATCH + 51 ISSUE action rows, got " + actions.length)

            const issues = await waitForIssueCount(result.txHash, 51)
            assert.strictEqual(issues.length, 51, "expected 51 issue rows, got " + issues.length)
            const invalid = issues.filter(r => r.status !== 'valid')
            assert.deepStrictEqual(invalid.map(r => r.tick + ' -> ' + r.status), [],
                "every sub-command in the batch must be valid")

            // Intra-batch parent visibility: the parent row is written under a LOWER
            // action index and each child had to see it to pass the parent checks.
            const parentAI = Number(issues[0].action_index)
            assert.strictEqual(issues[0].tick, parent, "the parent ISSUE is the first sub-command")
            for (const row of issues.slice(1))
                assert(Number(row.action_index) > parentAI,
                    "child " + row.tick + " must carry a higher action index than its parent")

            // Every child is queryable with the right owner and the credited supply.
            for (let n = 1; n <= CHILDREN; n++){
                const tick = parent + "." + n
                const tk = await tokenRow(tick)
                assert(tk, "child token " + tick + " should be queryable")
                assert.strictEqual(tk.owner, address, "child " + tick + " owner")
                assert.strictEqual(String(await balanceOf(address, tick)), '10',
                    "child " + tick + " mint supply credited")
            }

            // Per-child ISSUE_SUBTOKEN accounted: the fee schedule charged the parent
            // ISSUE and every child ISSUE_SUBTOKEN, which is the accounting the spec
            // asks this case to prove.
            const fees = await feesForTx(result.txHash)
            assert.strictEqual(fees.length, 51, "one fee record per sub-command")
            assert.strictEqual(Number(fees[0].gas_cost), 100000, "the parent pays ISSUE gas")
            for (const row of fees.slice(1))
                assert.strictEqual(Number(row.gas_cost), 50000,
                    "every child pays ISSUE_SUBTOKEN gas, got " + row.gas_cost)
            const expectedMode = state.GAS_MODE ? 2 : 1
            for (const row of fees)
                assert.strictEqual(Number(row.payment_mode), expectedMode,
                    "every sub-command should record payment_mode " + expectedMode)

            if (!state.GAS_MODE){
                console.log("A1: 51/51 valid on the native-fee lane, gas_cost 100000 + 50x50000, " +
                    "one fee pool covering " + totalXchain + " XCHAIN")
                return
            }

            // The ledger side, charged exactly (see the gas-expectation note above).
            const perChild      = XCHAIN_PER_CHILD_ISSUE
            const expectedSpent = XCHAIN_PER_ISSUE + CHILDREN * perChild
            // Pinned so the expectation cannot silently track a change in the very fee
            // arithmetic this test exists to hold still.
            assert.strictEqual(expectedSpent, 26,
                "gas schedule moved: 1 ISSUE + 50x0.5 ISSUE_SUBTOKEN should be 26 XCHAIN")
            const debits = await debitsForTx(result.txHash, GAS_TICK)
            assert.strictEqual(debits.length, 51, "one gas debit per sub-command")
            const spent = debits.reduce((s, d) => s + Number(d.amount), 0)
            assert.strictEqual(spent, expectedSpent,
                "gas debited should be 1 ISSUE + 50 ISSUE_SUBTOKEN charged exactly = " +
                expectedSpent + " XCHAIN")
            const gasAfter = await balanceOf(address, GAS_TICK)
            assert.strictEqual(Number(gasBefore) - Number(gasAfter), expectedSpent,
                "the source's XCHAIN balance moved by exactly the batch's gas")
            console.log("A1: 51/51 valid, gas_cost 100000 + 50x50000, " + expectedSpent +
                " XCHAIN debited across " + debits.length + " debits (per-child debit " +
                perChild + ")")
        })
    })
}
