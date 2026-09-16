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

// Covers v2 - edit. One part of order.test.js.

describe('ORDER', () => {

    describe('v2 - edit', () => {
        it('should create and edit an order', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("ORDER.V2", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let giveTick = "ORDGIVEv2"+address.substring(address.length-8)
            let getTick = "ORDGETv2"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, giveTick, 100, 50, 0, "Order edit give token", 50)
            await issueHelper.sendIssueV0(addr, getTick, 100, 50, 0, "Order edit get token", 50)
            await gasHelper.ensureGasBalance(addr, 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let createResult = await orderHelper.sendOrderV0(addr, COIN_CODE, giveTick, 10, COIN_CODE, getTick, 5, address, Math.floor(expirationDate.getTime() / 1000), null, null, "Order to edit")
            assert(createResult.order, "Order should be created")
            let orderActionIndex = Number(createResult.order["action_index"])

            let newExpiration = new Date()
            newExpiration.setMonth(newExpiration.getMonth() + 6)

            let editResult = await orderHelper.sendOrderEditV2(
                addr, orderActionIndex,
                Math.floor(newExpiration.getTime() / 1000),
                null, null, "Extending order expiration"
            )
            assert(editResult.txHash, "Order edit tx should have been sent")
        })
    })
})
