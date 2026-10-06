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
const orderHelper = require('../../helpers/orderHelper')
const batchHelper = require('../../helpers/batchHelper')
const { chainTipTime } = require('./shared')

module.exports = function registerCoinpayCases(){

    // ─── A5 (settlement half) ──────────────────────────────────────────────────
    context('A5: one COINPAY payment settles ONE obligation, not N', function () {
        it('leaves the second obligation pending', async function () {
            // Runs on every lane: the fee output is suppressed on the batch below, so
            // the only transaction-level value in play is the payment itself.

            const seller = await cryptoHelper.getNewFundedAddress("BIL.A5CP.S", COIN, NETWORK, null, "legacy", 0, 2)
            const buyer  = await cryptoHelper.getNewFundedAddress("BIL.A5CP.B", COIN, NETWORK, null, "legacy", 0, 2)
            const sAddr  = seller["address"]
            const bAddr  = buyer["address"]
            const tick   = "BILCP" + sAddr.substring(sAddr.length - 8)

            await issueHelper.sendIssueV0(seller, tick, 1000, 1000, 0, "A5 coinpay token", 1000)

            // Two independent matches to the SAME payee, so one payment output could in
            // principle be judged twice.
            const exp = (await chainTipTime()) + 86400
            const obligations = []
            for (let leg = 0; leg < 2; leg++){
                const sellerOrder = await orderHelper.sendOrderV0(
                    seller, COIN_CODE, tick, "100", COIN_CODE, "", "0.00100000",
                    sAddr, exp, "", "", "A5 sell leg " + leg)
                assert(sellerOrder.order, "seller ORDER leg " + leg)
                const buyerOrder = await orderHelper.sendOrderV0(
                    buyer, COIN_CODE, "", "0.00100000", COIN_CODE, tick, "100",
                    bAddr, exp, "", "", "A5 buy leg " + leg)
                assert(buyerOrder.order, "buyer ORDER leg " + leg)

                const match = await indexerDatabase.waitForOrderMatch({
                    giveActionIndex: Number(sellerOrder.order["action_index"]),
                    getActionIndex:  Number(buyerOrder.order["action_index"]),
                    status: 'pending_coinpay'
                }, 60000)
                assert(match, "ORDER_MATCH leg " + leg + " should be pending_coinpay")
                obligations.push(Number(match.action_index))
            }

            // ONE payment output, sized for ONE obligation, against TWO COINPAY commands.
            const result = await batchHelper.sendBatch(buyer, [
                "COINPAY|0|" + obligations[0],
                "COINPAY|0|" + obligations[1]
            ], { status: 'valid', skipNativeFeeInjection: true,
                 customOutputs: [{ address: sAddr, value: 100000 }] })
            assert(result.batch, "the BATCH itself is valid")

            // The settlement this case is about IS an observable row: the first
            // obligation flipping to 'fulfilled'. Both COINPAY sub-commands are
            // judged in list order inside the SAME batch action, so once the first
            // obligation carries its verdict the second one's is written too and
            // the split below can be read. Waiting on the row rather than on 20s
            // also means a run where nothing settles fails on the assertion that
            // names the split instead of on how busy the venue was.
            // give-up-ok: a wait that times out changes nothing; the per-obligation
            // status read below is the assertion, and it reports what is really there.
            await indexerDatabase.waitForCoinpayObligation(
                { actionIndex: obligations[0], coinpayStatus: 'fulfilled' }, 60000)

            const settled = []
            for (const ai of obligations){
                const row = await indexerDatabase.checkCoinpayObligation({ actionIndex: ai })
                settled.push(row ? row.coinpay_status : null)
            }
            console.log("A5 COINPAY txHash=" + result.txHash + " obligations=" +
                JSON.stringify(obligations) + " statuses=" + JSON.stringify(settled))

            // EXACTLY one, not "at most one". The weaker bound is satisfied by a batch
            // that settles NOTHING, and that is precisely how this test passed before
            // the decoder learned to capture a batched sub-command's payment output:
            // COINPAY never saw a COIN_AMOUNT at all, so `0 <= 1` held with the ledger
            // taking no part in it. Asserting the exact split is what makes this
            // evidence that the CUMULATIVE ACCOUNTING enforces one-settles-one, rather
            // than evidence that the path is inert.
            const fulfilled = settled.filter(s => s === 'fulfilled').length
            assert.strictEqual(fulfilled, 1,
                "one payment must settle EXACTLY one obligation, not none and not both " +
                "(settled " + fulfilled + ", statuses " + JSON.stringify(settled) + ")")
            assert.strictEqual(settled[0], 'fulfilled',
                "the first sub-command draws the payment: sub-commands bill in list order")
            assert.notStrictEqual(settled[1], 'fulfilled',
                "the second obligation must not be settled by the first obligation's payment")
        })

        // The converse, and the reason the case above is not just the old structural
        // inertness wearing a tighter assertion: when the batch really does carry a
        // payment for each obligation, EVERY obligation settles. One test alone cannot
        // tell "the ledger stopped the second draw" from "no draw ever happens"; the
        // pair can.
        it('settles BOTH obligations when each payee has its own output', async function () {
            // Two DIFFERENT sellers, so each obligation resolves its own payment output
            // by payee address rather than competing for one pool.
            const sellerA = await cryptoHelper.getNewFundedAddress("BIL.A5CP2.SA", COIN, NETWORK, null, "legacy", 0, 2)
            const sellerB = await cryptoHelper.getNewFundedAddress("BIL.A5CP2.SB", COIN, NETWORK, null, "legacy", 0, 2)
            const buyer   = await cryptoHelper.getNewFundedAddress("BIL.A5CP2.B",  COIN, NETWORK, null, "legacy", 0, 2)
            const bAddr   = buyer["address"]

            const exp = (await chainTipTime()) + 86400
            const obligations = []
            const payees = []
            for (const seller of [sellerA, sellerB]){
                const sAddr = seller["address"]
                const tick  = "BILC2" + sAddr.substring(sAddr.length - 8)
                await issueHelper.sendIssueV0(seller, tick, 1000, 1000, 0, "A5 coinpay token", 1000)

                const sellerOrder = await orderHelper.sendOrderV0(
                    seller, COIN_CODE, tick, "100", COIN_CODE, "", "0.00100000",
                    sAddr, exp, "", "", "A5 two-payee sell")
                assert(sellerOrder.order, "seller ORDER for " + sAddr)
                const buyerOrder = await orderHelper.sendOrderV0(
                    buyer, COIN_CODE, "", "0.00100000", COIN_CODE, tick, "100",
                    bAddr, exp, "", "", "A5 two-payee buy")
                assert(buyerOrder.order, "buyer ORDER for " + sAddr)

                const match = await indexerDatabase.waitForOrderMatch({
                    giveActionIndex: Number(sellerOrder.order["action_index"]),
                    getActionIndex:  Number(buyerOrder.order["action_index"]),
                    status: 'pending_coinpay'
                }, 60000)
                assert(match, "ORDER_MATCH for " + sAddr + " should be pending_coinpay")
                obligations.push(Number(match.action_index))
                payees.push(sAddr)
            }

            // One output PER payee, each sized for that payee's single obligation.
            const result = await batchHelper.sendBatch(buyer, [
                "COINPAY|0|" + obligations[0],
                "COINPAY|0|" + obligations[1]
            ], { status: 'valid', skipNativeFeeInjection: true,
                 customOutputs: [{ address: payees[0], value: 100000 },
                                 { address: payees[1], value: 100000 }] })
            assert(result.batch, "the BATCH itself is valid")

            // Both obligations are expected to settle, so wait on each one reaching
            // 'fulfilled' instead of on a fixed window. The status read below is
            // unchanged, so a wait that gives up still reports what is really there.
            for (const ai of obligations){
                // give-up-ok: as above, the status read below is the assertion.
                await indexerDatabase.waitForCoinpayObligation(
                    { actionIndex: ai, coinpayStatus: 'fulfilled' }, 20000)
            }

            const settled = []
            for (const ai of obligations){
                const row = await indexerDatabase.checkCoinpayObligation({ actionIndex: ai })
                settled.push(row ? row.coinpay_status : null)
            }
            console.log("A5 COINPAY two-payee txHash=" + result.txHash + " obligations=" +
                JSON.stringify(obligations) + " statuses=" + JSON.stringify(settled))

            assert.deepStrictEqual(settled, ['fulfilled', 'fulfilled'],
                "each obligation draws its OWN payee's output, so both settle")
        })
    })
}
