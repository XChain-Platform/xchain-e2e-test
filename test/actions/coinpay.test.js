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
        // Pending (not implemented): asserting escrow release on obligation expiry
        // needs mining control to advance block_time past the obligation's
        // expiration timestamp. Marked it.skip so the suite reports it as pending
        // rather than green-with-no-assertion (tracked as ). Implement by
        // mining regtest blocks with future timestamps, then asserting the escrowed
        // tokens are credited back to the payer and the obligation is closed.
        it.skip('should expire unfulfilled obligation and release escrowed tokens', async function () {
        })
    })
})
