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
const issueHelper = require('../helpers/issueHelper')
const mintHelper = require('../helpers/mintHelper')
const orderHelper = require('../helpers/orderHelper')
const coinpayHelper = require('../helpers/coinpayHelper')

// Read a token balance straight from the indexer DB (the waitFor* helpers only
// poll for presence, not for an exact settled amount).
async function balanceOf(address, tick) {
    const conn = await indexerDatabase.getConnection()
    try {
        const rows = await conn.query(`SELECT b.amount FROM balances b
            JOIN index_addresses ia ON ia.id=b.address_id
            JOIN index_tickers it ON it.id=b.tick_id
            WHERE ia.address=? AND it.tick=?`, [address, tick])
        return rows.length ? String(rows[0].amount) : '0'
    } finally {
        await conn.release()
    }
}

describe('COINPAY', function () {

    describe('v0: Happy path: Token-for-Coin settlement', function () {
        it('should create matching native coin orders, send COINPAY, and settle', async function () {
            let sellerAddr = await cryptoHelper.getNewFundedAddress(
                "COINPAY.SELLER", COIN, NETWORK, null, "legacy", 0, 1
            )

            // buyer needs enough for order fee + coinpay payment
            let buyerAddr = await cryptoHelper.getNewFundedAddress(
                "COINPAY.BUYER", COIN, NETWORK, null, "legacy", 0, 2
            )

            // mintSupply arg already credits 1000 to the seller; a separate MINT would exceed maxSupply
            let tick = "CP" + sellerAddr["address"].substring(5, 12).toUpperCase()
            await issueHelper.sendIssueV0(sellerAddr, tick, "1000", "1000", "8", "COINPay test token", "1000")

            // seller: sell 100 tokens for 0.001 native coin
            let expiration = Math.floor(Date.now() / 1000) + 86400 // 24 hours from now
            let sellerOrder = await orderHelper.sendOrderV0(
                sellerAddr, COIN_CODE, tick, "100.00000000",
                COIN_CODE, "", "0.00100000",
                sellerAddr["address"], expiration, "", "", "Selling tokens for coin"
            )
            assert(sellerOrder.order, "Seller ORDER should exist in DB")

            // buyer: buy tokens with 0.001 native coin
            let buyerOrder = await orderHelper.sendOrderV0(
                buyerAddr, COIN_CODE, "", "0.00100000",
                COIN_CODE, tick, "100.00000000",
                buyerAddr["address"], expiration, "", "", "Buying tokens with coin"
            )
            assert(buyerOrder.order, "Buyer ORDER should exist in DB")

            // Filter by the specific orders this test created so we don't pick up a leftover
            // pending obligation from a previous run. The matcher records the newer order (buyer)
            // on the get side and the existing order (seller) on the give side (see indexer/db.js createOrderMatch).
            let orderMatch = await indexerDatabase.waitForOrderMatch({
                giveActionIndex: Number(sellerOrder.order["action_index"]),
                getActionIndex:  Number(buyerOrder.order["action_index"]),
                status: 'pending_coinpay'
            }, 30000)
            assert(orderMatch, "ORDER_MATCH with pending_coinpay should exist")

            let obligation = await indexerDatabase.waitForCoinpayObligation({
                actionIndex: Number(orderMatch.action_index),
                coinpayStatus: 'pending_coinpay'
            }, 30000)
            assert(obligation, "COINPay obligation should exist")

            let coinpayResult = await coinpayHelper.sendCoinpayV0(
                buyerAddr,
                Number(orderMatch.action_index),
                sellerAddr["address"],
                100000  // 0.001 BTC in satoshis
            )
            assert(coinpayResult.coinpay, "COINPAY should be valid in DB")

            let fulfilledObligation = await indexerDatabase.waitForCoinpayObligation({
                actionIndex: Number(orderMatch.action_index),
                coinpayStatus: 'fulfilled'
            }, 30000)
            assert(fulfilledObligation, "COINPay obligation should be fulfilled")

            let credit = await indexerDatabase.waitForCredit({
                address: buyerAddr["address"],
                tick: tick
            }, 30000)
            assert(credit, "Buyer should have received token credit")
        })
    })

    describe('v0: COINPay obligation expires', function () {
        this.timeout(0)

        it('should expire an unfulfilled obligation and release escrowed tokens to the seller', async function () {
            let sellerAddr = await cryptoHelper.getNewFundedAddress(
                "COINPAY.EXP.SELLER", COIN, NETWORK, null, "legacy", 0, 1
            )
            let buyerAddr = await cryptoHelper.getNewFundedAddress(
                "COINPAY.EXP.BUYER", COIN, NETWORK, null, "legacy", 0, 1
            )

            // mintSupply arg credits 1000 to the seller (a separate MINT would exceed maxSupply)
            let tick = "CE" + sellerAddr["address"].substring(5, 12).toUpperCase()
            await issueHelper.sendIssueV0(sellerAddr, tick, "1000", "1000", "8", "COINPay expiry token", "1000")

            // seller lists 100 tokens for 0.001 native coin (escrows the 100 tokens)
            let orderExpiration = Math.floor(Date.now() / 1000) + 86400 // 24h; the ORDER itself must not expire first
            let sellerOrder = await orderHelper.sendOrderV0(
                sellerAddr, COIN_CODE, tick, "100.00000000",
                COIN_CODE, "", "0.00100000",
                sellerAddr["address"], orderExpiration, "", "", "Selling tokens for coin"
            )
            assert(sellerOrder.order, "Seller ORDER should exist in DB")

            // buyer posts the matching coin order but will never send the COINPAY payment
            let buyerOrder = await orderHelper.sendOrderV0(
                buyerAddr, COIN_CODE, "", "0.00100000",
                COIN_CODE, tick, "100.00000000",
                buyerAddr["address"], orderExpiration, "", "", "Buying tokens with coin"
            )
            assert(buyerOrder.order, "Buyer ORDER should exist in DB")

            // The match opens a pending_coinpay obligation escrowing the seller's 100 tokens.
            let orderMatch = await indexerDatabase.waitForOrderMatch({
                giveActionIndex: Number(sellerOrder.order["action_index"]),
                getActionIndex:  Number(buyerOrder.order["action_index"]),
                status: 'pending_coinpay'
            }, 30000)
            assert(orderMatch, "ORDER_MATCH with pending_coinpay should exist")
            let obligationIndex = Number(orderMatch.action_index)

            let obligation = await indexerDatabase.waitForCoinpayObligation({
                actionIndex: obligationIndex,
                coinpayStatus: 'pending_coinpay'
            }, 30000)
            assert(obligation, "COINPay obligation should exist and be pending")

            // The escrow removed the 100 tokens from the seller's spendable balance.
            assert.strictEqual(await balanceOf(sellerAddr["address"], tick), "900",
                "Seller's 100 tokens are escrowed while the obligation is pending")

            // The buyer never pays. Drive the obligation past its deadline. Unlike the
            // block-height deadlines used by ORDER/attestation expiry, the COINPay
            // obligation expires on block_time (match block_time + COINPAY_EXPIRATION,
            // 2h). Rather than wait two real hours, freeze the node clock past the
            // deadline and mine: the first block whose block_time exceeds the
            // obligation's expiration makes the indexer's per-block expiry pass emit
            // COINPAY_EXPIRE, which releases the escrow.
            let expireAt = Number(obligation.expiration) + 600 // 10 min past the deadline

            // Pause the auto-miner so it cannot slip a real-time block into our window
            // (a real-time block would sit below the deadline and not trigger expiry).
            await regtestMinerConnector.pauseMining()
            try {
                await nodeConnector.setMockTime(expireAt)
                // Mine at the mocked time; two blocks gives the decoder+indexer a clear
                // block whose block_time is past the deadline to run processExpirations on.
                await regtestMinerConnector.generateBlocks(2)

                let expiredObligation = await indexerDatabase.waitForCoinpayObligation({
                    actionIndex: obligationIndex,
                    coinpayStatus: 'expired'
                }, 120000)
                assert(expiredObligation, "COINPay obligation should flip to 'expired' once block_time passes its deadline")
            } finally {
                // Release the mock clock and restore the normal cadence so the shared
                // regtest node is not left time-frozen for other tests.
                await nodeConnector.setMockTime(0)
                await regtestMinerConnector.resumeMining()
            }

            // Escrow released: the seller's full 1000 tokens are spendable again.
            let restored = "0"
            for (let i = 0; i < 30 && restored !== "1000"; i++) {
                restored = await balanceOf(sellerAddr["address"], tick)
                if (restored !== "1000") await new Promise(r => setTimeout(r, 2000))
            }
            assert.strictEqual(restored, "1000", "Escrowed tokens are released back to the seller on expiry")

            // The buyer, who never sent COINPAY, is credited nothing.
            assert.strictEqual(await balanceOf(buyerAddr["address"], tick), "0",
                "Buyer who never paid is not credited any tokens")
        })
    })
})
