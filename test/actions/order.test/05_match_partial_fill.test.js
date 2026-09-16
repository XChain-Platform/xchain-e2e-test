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

// Covers match - partial fill. One part of order.test.js.

describe('ORDER', () => {

    describe('match - partial fill', () => {
        it('should partially fill a large order with a smaller counter-order', async () => {
            // Large order: GIVE 100 tokenA, GET 70 tokenB (price = 0.7)
            // Small counter: GIVE 7 tokenB, GET 10 tokenA (price = 10/7 = 1.4285...)
            // Expected: partial fill of 10 tokenA for 7 tokenB, large order stays open
            let addr1 = await cryptoHelper.getNewFundedAddress("ORDER.PF1", COIN, NETWORK, null, "legacy", 0, 1)
            let addr2 = await cryptoHelper.getNewFundedAddress("ORDER.PF2", COIN, NETWORK, null, "legacy", 0, 1)
            let address1 = addr1["address"]
            let address2 = addr2["address"]
            let tokenA = "ORDPFa"+address1.substring(address1.length-8)
            let tokenB = "ORDPFb"+address1.substring(address1.length-8)

            await issueHelper.sendIssueV0(addr1, tokenA, 1000, 500, 0, "PF token A", 500)
            await issueHelper.sendIssueV0(addr1, tokenB, 1000, 500, 0, "PF token B", 500)
            await sendHelper.sendSendV0(addr1, tokenB, 100, address2, "Fund addr2 tokenB")
            await gasHelper.ensureGasBalance(addr1, 100)
            await gasHelper.ensureGasBalance(addr2, 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            let bigOrder = await orderHelper.sendOrderV0(addr1, COIN_CODE, tokenA, 100, COIN_CODE, tokenB, 70, address1, expiration, null, null, "Large order")
            assert(bigOrder.order, "Big order should exist")
            let bigOrderAI = Number(bigOrder.order["action_index"])

            let smallOrder = await orderHelper.sendOrderV0(addr2, COIN_CODE, tokenB, 7, COIN_CODE, tokenA, 10, address2, expiration, null, null, "Small counter order")
            assert(smallOrder.order, "Small order should exist")

            let match = await indexerDatabase.waitForOrderMatch({ giveActionIndex: bigOrderAI, status: "valid" }, 30000)
            assert(match, "Partial fill match should exist")

            let completedSmall = await indexerDatabase.waitForOrder({ source: address2, giveTick: tokenB, orderStatus: "complete" }, 30000)
            assert(completedSmall, "Small order should be complete")

            let openBig = await indexerDatabase.waitForOrder({ source: address1, giveTick: tokenA, orderStatus: "open" }, 30000)
            assert(openBig, "Big order should still be open after partial fill")
        })
    })
})
