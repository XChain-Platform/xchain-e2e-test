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

// Covers match - repeating decimal price. One part of order.test.js.

describe('ORDER', () => {

    describe('match - repeating decimal price', () => {
        it('should correctly match orders with a 1:3 ratio (repeating decimal price)', async () => {
            // Price = 3/1 = 3.0 and 1/3 = 0.333... (repeating decimal)
            // This tests that bignumber precision handles the truncation correctly
            let addr1 = await cryptoHelper.getNewFundedAddress("ORDER.FP1", COIN, NETWORK, null, "legacy", 0, 1)
            let addr2 = await cryptoHelper.getNewFundedAddress("ORDER.FP2", COIN, NETWORK, null, "legacy", 0, 1)
            let address1 = addr1["address"]
            let address2 = addr2["address"]
            let tokenA = "ORDFPa"+address1.substring(address1.length-8)
            let tokenB = "ORDFPb"+address1.substring(address1.length-8)

            await issueHelper.sendIssueV0(addr1, tokenA, 1000, 500, 0, "FP token A", 500)
            await issueHelper.sendIssueV0(addr1, tokenB, 1000, 500, 0, "FP token B", 500)
            await sendHelper.sendSendV0(addr1, tokenB, 300, address2, "Fund addr2 tokenB")
            await gasHelper.ensureGasBalance(addr1, 100)
            await gasHelper.ensureGasBalance(addr2, 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            let order1 = await orderHelper.sendOrderV0(addr1, COIN_CODE, tokenA, 1, COIN_CODE, tokenB, 3, address1, expiration, null, null, "1:3 ratio order")
            assert(order1.order, "Order 1 should exist")
            let order1AI = Number(order1.order["action_index"])

            let order2 = await orderHelper.sendOrderV0(addr2, COIN_CODE, tokenB, 3, COIN_CODE, tokenA, 1, address2, expiration, null, null, "3:1 ratio counter")
            assert(order2.order, "Order 2 should exist")

            let match = await indexerDatabase.waitForOrderMatch({ giveActionIndex: order1AI, status: "valid" }, 30000)
            assert(match, "Orders with repeating decimal price should match")

            let completed1 = await indexerDatabase.waitForOrder({ source: address1, giveTick: tokenA, orderStatus: "complete" }, 30000)
            assert(completed1, "Order 1 should be complete")

            let completed2 = await indexerDatabase.waitForOrder({ source: address2, giveTick: tokenB, orderStatus: "complete" }, 30000)
            assert(completed2, "Order 2 should be complete")
        })
    })
})
