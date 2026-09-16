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
const cryptoHelper = require('../../cryptoHelper')
const issueHelper = require('../../helpers/issueHelper')
const sendHelper = require('../../helpers/sendHelper')
const gasHelper = require('../../helpers/gasHelper')
const orderHelper = require('../../helpers/orderHelper')

// Covers match - full exchange. One part of order.test.js.

describe('ORDER', () => {

    describe('match - full exchange', () => {
        it('should match two counter-orders and complete the exchange', async () => {
            // Two separate addresses (matching requires different SOURCE)
            let addr1 = await cryptoHelper.getNewFundedAddress("ORDER.MATCH1", COIN, NETWORK, null, "legacy", 0, 1)
            let addr2 = await cryptoHelper.getNewFundedAddress("ORDER.MATCH2", COIN, NETWORK, null, "legacy", 0, 1)
            let address1 = addr1["address"]
            let address2 = addr2["address"]
            let tokenA = "ORDMA"+address1.substring(address1.length-8)
            let tokenB = "ORDMB"+address1.substring(address1.length-8)

            await issueHelper.sendIssueV0(addr1, tokenA, 100, 50, 0, "Match token A", 50)
            await issueHelper.sendIssueV0(addr1, tokenB, 100, 50, 0, "Match token B", 50)

            // give addr2 some tokenB so it can offer it
            await sendHelper.sendSendV0(addr1, tokenB, 20, address2, "Fund addr2 with tokenB")

            await gasHelper.ensureGasBalance(addr1, 100)
            await gasHelper.ensureGasBalance(addr2, 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90 // 90 days

            let order1 = await orderHelper.sendOrderV0(addr1, COIN_CODE, tokenA, 10, COIN_CODE, tokenB, 5, address1, expiration, null, null, "Selling tokenA for tokenB")
            assert(order1.order, "Order 1 should exist in DB")
            let order1ActionIndex = Number(order1.order["action_index"])

            // exact counter-order
            let order2 = await orderHelper.sendOrderV0(addr2, COIN_CODE, tokenB, 5, COIN_CODE, tokenA, 10, address2, expiration, null, null, "Buying tokenA with tokenB")
            assert(order2.order, "Order 2 should exist in DB")
            let order2ActionIndex = Number(order2.order["action_index"])

            let match = await indexerDatabase.waitForOrderMatch({ giveActionIndex: order1ActionIndex, getActionIndex: order2ActionIndex, status: "valid" }, 30000)
            assert(match, "Order match should exist in DB")

            let completedOrder1 = await indexerDatabase.waitForOrder({ source: address1, giveTick: tokenA, orderStatus: "complete" }, 30000)
            assert(completedOrder1, "Order 1 should be complete")

            let completedOrder2 = await indexerDatabase.waitForOrder({ source: address2, giveTick: tokenB, orderStatus: "complete" }, 30000)
            assert(completedOrder2, "Order 2 should be complete")
        })
    })
})
