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
const issueHelper = require('../../helpers/issueHelper')
const batchHelper = require('../../helpers/batchHelper')
const transactionHelper = require('../../helpers/core/transactionHelper')
const {
    GIVE_PER_FILL, INSUFFICIENT, fillSats, fillCoin, dispensersForTx, tokenBalance,
    waitForDispenses, waitForBalance, dispenserCmd, statuses
} = require('./dispenser_fixture')

module.exports = function registerDispenserBatchCreateCases(){

    // ─── Row 35 ────────────────────────────────────────────────────────────
    //
    // TWO creates in ONE batch, not one: the decoder collapses a batch's creates to
    // a single registration per operating address because its dispensers table is
    // keyed on (tx_index, address_id), and that collapse is itself part of the fix
    // (a second create would collide on the primary key and be read as stored).
    // Two creates therefore exercise the registry AND give the pair evidence - the
    // second payment must reach the dispenser the first one did not fund.
    describe('row 35: a dispenser created inside a BATCH dispenses on a live chain', function () {

        let host = null, hostAddress = null, buyer = null, buyerAddress = null
        let tick = null, batchTxHash = null
        let dispenserIndexes = []

        before(async function () {
            host  = await cryptoHelper.getNewFundedAddress("BIL.D35.H", COIN, NETWORK, null, "legacy", 0, 2)
            buyer = await cryptoHelper.getNewFundedAddress("BIL.D35.B", COIN, NETWORK, null, "legacy", 0, 2)
            hostAddress  = host["address"]
            buyerAddress = buyer["address"]
            tick = "BILD5" + hostAddress.substring(hostAddress.length - 8)

            await issueHelper.sendIssueV0(host, tick, 1000, 1000, 0, "row 35 batch dispensers", 1000)

            const commands = [0, 1].map(n => dispenserCmd(
                tick, GIVE_PER_FILL, GIVE_PER_FILL, fillCoin(), hostAddress,
                'row 35 batched dispenser ' + n))

            const result = await batchHelper.sendBatch(host, commands, { status: 'valid' })
            assert(result.batch, "the BATCH itself is valid")
            batchTxHash = result.txHash

            // The indexer half: both creates land as open dispensers. This was never
            // the defect - it is the DECODER that did not see them - so it is a
            // precondition here rather than the witness.
            const created = await dispensersForTx(batchTxHash)
            assert.strictEqual(created.length, 2,
                "a batch's two DISPENSER sub-commands each create a dispenser")
            for (const row of created)
                assert.strictEqual(row.status, 'valid')
            dispenserIndexes = created.map(r => Number(r.action_index))
            console.log("row 35 batch txHash=" + batchTxHash + " host=" + hostAddress +
                " tick=" + tick + " dispensers=" + JSON.stringify(dispenserIndexes))
        })

        it('captures a payment to the batch-created dispenser and dispenses', async function () {
            const before = await tokenBalance(buyerAddress, tick)

            const txHash = await transactionHelper.createSimpleTransaction(
                buyer, hostAddress, fillSats())

            const rows  = await waitForDispenses(txHash, 2)
            const after = await waitForBalance(buyerAddress, tick, before + GIVE_PER_FILL)
            console.log("row 35 ONE-FILL txHash=" + txHash +
                " statuses=" + JSON.stringify(statuses(rows)) +
                " getAmounts=" + JSON.stringify(rows.map(r => r.get_amount)) +
                " buyerBalance=" + before + "->" + after)

            // The witness itself: rows exist at all. Before the registry learned to
            // read a batch's sub-commands this payment was not classified as a
            // dispense trigger, so there was nothing here to have a status.
            assert.strictEqual(rows.length, 2,
                "both batch-created dispensers are evaluated against the payment")
            const valid = rows.filter(r => r.status === 'valid')
            assert.strictEqual(valid.length, 1,
                "one payment buys exactly ONE fill from the batch-created pair (statuses " +
                JSON.stringify(statuses(rows)) + ")")
            assert.strictEqual(Number(valid[0].dispenser_action_index), dispenserIndexes[0])
            assert.strictEqual(rows.filter(r => r.status !== 'valid')[0].status, INSUFFICIENT)

            // Balances actually move, which is the part a registry-only assertion
            // could never prove.
            assert.strictEqual(after, before + GIVE_PER_FILL,
                "one fill of " + tick + " moved out of the batch-created dispenser")
            assert.strictEqual(Number(valid[0].give_amount), GIVE_PER_FILL)
        })

        it('dispenses from the SECOND batch-created dispenser on a second payment', async function () {
            // Pair evidence, and the second half of row 35: the sibling create is
            // not merely present, it is spendable. The first dispenser is exhausted
            // and closed, so this payment reaches the one the tally stopped.
            const before = await tokenBalance(buyerAddress, tick)

            const txHash = await transactionHelper.createSimpleTransaction(
                buyer, hostAddress, fillSats())

            const rows  = await waitForDispenses(txHash, 1)
            const after = await waitForBalance(buyerAddress, tick, before + GIVE_PER_FILL)
            console.log("row 35 SECOND-FILL txHash=" + txHash +
                " statuses=" + JSON.stringify(statuses(rows)) +
                " buyerBalance=" + before + "->" + after)

            assert.strictEqual(rows.length, 1,
                "the exhausted dispenser has closed, leaving the sibling")
            assert.deepStrictEqual(statuses(rows), ['valid'])
            assert.strictEqual(Number(rows[0].dispenser_action_index), dispenserIndexes[1],
                "the SECOND create in the batch dispenses too")
            assert.strictEqual(after, before + GIVE_PER_FILL)
        })
    })
}
