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

// Covers match - high precision decimals. One part of order.test.js.

describe('ORDER', () => {

    describe('match - high precision decimals', () => {
        it('should match orders on tokens with 8 decimal places', async () => {
            // Tokens with 8 decimals (amounts like 0.00000001).
            // Tests that bignumber handles small precision amounts correctly.
            let addr1 = await cryptoHelper.getNewFundedAddress("ORDER.HP1", COIN, NETWORK, null, "legacy", 0, 1)
            let addr2 = await cryptoHelper.getNewFundedAddress("ORDER.HP2", COIN, NETWORK, null, "legacy", 0, 1)
            let address1 = addr1["address"]
            let address2 = addr2["address"]
            let tokenA = "ORDHPa"+address1.substring(address1.length-8)
            let tokenB = "ORDHPb"+address1.substring(address1.length-8)

            // 8 decimal places
            await issueHelper.sendIssueV0(addr1, tokenA, 1000, 500, 8, "HP token A", 500)
            await issueHelper.sendIssueV0(addr1, tokenB, 1000, 500, 8, "HP token B", 500)
            await sendHelper.sendSendV0(addr1, tokenB, "1.23456789", address2, "Fund addr2 tokenB")
            await gasHelper.ensureGasBalance(addr1, 100)
            await gasHelper.ensureGasBalance(addr2, 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            let order1 = await orderHelper.sendOrderV0(addr1, COIN_CODE, tokenA, "0.00000003", COIN_CODE, tokenB, "1.23456789", address1, expiration, null, null, "High precision order")
            assert(order1.order, "HP order 1 should exist")
            let order1AI = Number(order1.order["action_index"])

            let order2 = await orderHelper.sendOrderV0(addr2, COIN_CODE, tokenB, "1.23456789", COIN_CODE, tokenA, "0.00000003", address2, expiration, null, null, "High precision counter")
            assert(order2.order, "HP order 2 should exist")

            let match = await indexerDatabase.waitForOrderMatch({ giveActionIndex: order1AI, status: "valid" }, 30000)
            assert(match, "High precision orders should match")

            let completed1 = await indexerDatabase.waitForOrder({ source: address1, giveTick: tokenA, orderStatus: "complete" }, 30000)
            assert(completed1, "HP order 1 should be complete")

            let completed2 = await indexerDatabase.waitForOrder({ source: address2, giveTick: tokenB, orderStatus: "complete" }, 30000)
            assert(completed2, "HP order 2 should be complete")
        })
    })
})
