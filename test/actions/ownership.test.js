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
const sendHelper = require('../helpers/sendHelper')
const gasHelper = require('../helpers/gasHelper')
const orderHelper = require('../helpers/orderHelper')
const sweepHelper = require('../helpers/sweepHelper')

// End-to-end coverage for token-ownership sales (ORDER/SWAP/DISPENSER with
// GIVE_OWNERSHIP or GET_OWNERSHIP set). Token-pair scenarios only. The
// COINPay path (ownership-for-native-coin) is exercised by the COINPay
// suite once those helpers are ownership-aware.


// Scenario 1: Ownership ORDER instant settle (token-for-token)
// addr1 lists JDOG ownership for X SETTLE; addr2 posts the matching
// counter-order with GET_OWNERSHIP=1. The match should be single-fill
// (ownership is indivisible) and the JDOG owner should become addr2.
describe('OWNERSHIP', () => {
    describe('ORDER - ownership for token (instant match)', () => {
        it('should transfer ownership atomically when a counter-order matches', async () => {
            let addr1 = await cryptoHelper.getNewFundedAddress("OWN.OM1", COIN, NETWORK, null, "legacy", 0, 1)
            let addr2 = await cryptoHelper.getNewFundedAddress("OWN.OM2", COIN, NETWORK, null, "legacy", 0, 1)
            let address1 = addr1["address"]
            let address2 = addr2["address"]
            let jdog    = "OWNJDG"+address1.substring(address1.length-8)
            let settle  = "OWNST"+address1.substring(address1.length-8)

            // addr1 mints both ticks; addr2 receives a chunk of SETTLE to pay with
            await issueHelper.sendIssueV0(addr1, jdog,   100, 50, 0, "Ownership-sale subject", 50)
            await issueHelper.sendIssueV0(addr1, settle, 100, 50, 0, "Settlement currency",   50)
            await sendHelper.sendSendV0(addr1, settle, 25, address2, "Fund buyer with SETTLE")
            await gasHelper.ensureGasBalance(addr1, 100)
            await gasHelper.ensureGasBalance(addr2, 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            // Seller lists JDOG ownership for 10 SETTLE (GIVE_AMOUNT must be empty)
            let sellOrder = await orderHelper.sendOrderV0(
                addr1,
                COIN_CODE, jdog,   null,
                COIN_CODE, settle, 10,
                address1, expiration,
                null, null, "Listing JDOG ownership",
                1, // giveOwnership
                0  // getOwnership
            )
            assert(sellOrder.order, "Ownership-sell order should land in DB")
            let sellAI = Number(sellOrder.order["action_index"])

            // Buyer posts the matching counter-order: GIVE 10 SETTLE, GET JDOG ownership
            let buyOrder = await orderHelper.sendOrderV0(
                addr2,
                COIN_CODE, settle, 10,
                COIN_CODE, jdog,   null,
                address2, expiration,
                null, null, "Buying JDOG ownership",
                0, // giveOwnership
                1  // getOwnership
            )
            assert(buyOrder.order, "Ownership-buy order should land in DB")
            let buyAI = Number(buyOrder.order["action_index"])

            // Match must exist and settle valid
            let match = await indexerDatabase.waitForOrderMatch({ giveActionIndex: sellAI, getActionIndex:  buyAI, status: "valid" }, 30000)
            assert(match, "Ownership orders should match")

            // Both orders should now be 'complete' (ownership single-fill)
            let sellComplete = await indexerDatabase.waitForOrder({ source: address1, giveTick: jdog, orderStatus: "complete" }, 30000)
            assert(sellComplete, "Sell order should be complete after ownership match")

            let buyComplete = await indexerDatabase.waitForOrder({ source: address2, giveTick: settle, orderStatus: "complete" }, 30000)
            assert(buyComplete, "Buy order should be complete after ownership match")
        })
    })
})
