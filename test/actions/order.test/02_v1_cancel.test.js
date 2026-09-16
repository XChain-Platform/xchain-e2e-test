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

// Covers v1 - cancel. One part of order.test.js.

describe('ORDER', () => {

    describe('v1 - cancel', () => {
        it('should create and cancel an order', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("ORDER.V1", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let giveTick = "ORDGIVEv1"+address.substring(address.length-8)
            let getTick = "ORDGETv1"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, giveTick, 100, 50, 0, "Order cancel give token", 50)
            await issueHelper.sendIssueV0(addr, getTick, 100, 50, 0, "Order cancel get token", 50)
            await gasHelper.ensureGasBalance(addr, 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let createResult = await orderHelper.sendOrderV0(addr, COIN_CODE, giveTick, 10, COIN_CODE, getTick, 5, address, Math.floor(expirationDate.getTime() / 1000), null, null, "Order to cancel")
            assert(createResult.order, "Order should be created")
            let orderActionIndex = Number(createResult.order["action_index"])

            let cancelResult = await orderHelper.sendOrderCancelV1(addr, orderActionIndex, "Cancelling order")
            assert(cancelResult.txHash, "Order cancel tx should have been sent")

            let closedOrder = await indexerDatabase.waitForOrder({ source: address, giveTick: giveTick, orderStatus: "cancelled" }, 30000)
            assert(closedOrder, "Order should be closed after cancel")
        })
    })
})
