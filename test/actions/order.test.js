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

describe('ORDER', () => {
    describe('v0 - create', () => {
        it('should create an order v0', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("ORDER.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let giveTick = "ORDGIVEv0"+address.substring(address.length-8)
            let getTick = "ORDGETv0"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, giveTick, 100, 50, 0, "Order give token", 50)
            await issueHelper.sendIssueV0(addr, getTick, 100, 50, 0, "Order get token", 50)

            await gasHelper.mintGas(addr, 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let result = await orderHelper.sendOrderV0(
                addr,
                COIN_CODE, giveTick, 10,
                COIN_CODE, getTick, 5,
                address,
                Math.floor(expirationDate.getTime() / 1000),
                null, null,
                "Order test v0"
            )
            assert(result.order, "Order v0 should exist in DB")
        })
    })

    describe('v1 - cancel', () => {
        it('should create and cancel an order', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("ORDER.V1", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let giveTick = "ORDGIVEv1"+address.substring(address.length-8)
            let getTick = "ORDGETv1"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, giveTick, 100, 50, 0, "Order cancel give token", 50)
            await issueHelper.sendIssueV0(addr, getTick, 100, 50, 0, "Order cancel get token", 50)
            await gasHelper.mintGas(addr, 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let createResult = await orderHelper.sendOrderV0(
                addr,
                COIN_CODE, giveTick, 10,
                COIN_CODE, getTick, 5,
                address,
                Math.floor(expirationDate.getTime() / 1000),
                null, null,
                "Order to cancel"
            )
            assert(createResult.order, "Order should be created")
            let orderActionIndex = Number(createResult.order["action_index"])

            let cancelResult = await orderHelper.sendOrderCancelV1(addr, orderActionIndex, "Cancelling order")
            assert(cancelResult.txHash, "Order cancel tx should have been sent")

            let closedOrder = await indexerDatabase.waitForOrder({
                source: address,
                giveTick: giveTick,
                orderStatus: "cancelled"
            }, 30000)
            assert(closedOrder, "Order should be closed after cancel")
        })
    })

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

            await gasHelper.mintGas(addr1, 100)
            await gasHelper.mintGas(addr2, 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90 // 90 days

            let order1 = await orderHelper.sendOrderV0(
                addr1,
                COIN_CODE, tokenA, 10,
                COIN_CODE, tokenB, 5,
                address1, expiration,
                null, null, "Selling tokenA for tokenB"
            )
            assert(order1.order, "Order 1 should exist in DB")
            let order1ActionIndex = Number(order1.order["action_index"])

            // exact counter-order
            let order2 = await orderHelper.sendOrderV0(
                addr2,
                COIN_CODE, tokenB, 5,
                COIN_CODE, tokenA, 10,
                address2, expiration,
                null, null, "Buying tokenA with tokenB"
            )
            assert(order2.order, "Order 2 should exist in DB")
            let order2ActionIndex = Number(order2.order["action_index"])

            let match = await indexerDatabase.waitForOrderMatch({
                giveActionIndex: order1ActionIndex,
                getActionIndex: order2ActionIndex,
                status: "valid"
            }, 30000)
            assert(match, "Order match should exist in DB")

            let completedOrder1 = await indexerDatabase.waitForOrder({
                source: address1,
                giveTick: tokenA,
                orderStatus: "complete"
            }, 30000)
            assert(completedOrder1, "Order 1 should be complete")

            let completedOrder2 = await indexerDatabase.waitForOrder({
                source: address2,
                giveTick: tokenB,
                orderStatus: "complete"
            }, 30000)
            assert(completedOrder2, "Order 2 should be complete")
        })
    })

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
            await gasHelper.mintGas(addr1, 100)
            await gasHelper.mintGas(addr2, 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            let order1 = await orderHelper.sendOrderV0(
                addr1,
                COIN_CODE, tokenA, 1,
                COIN_CODE, tokenB, 3,
                address1, expiration,
                null, null, "1:3 ratio order"
            )
            assert(order1.order, "Order 1 should exist")
            let order1AI = Number(order1.order["action_index"])

            let order2 = await orderHelper.sendOrderV0(
                addr2,
                COIN_CODE, tokenB, 3,
                COIN_CODE, tokenA, 1,
                address2, expiration,
                null, null, "3:1 ratio counter"
            )
            assert(order2.order, "Order 2 should exist")

            let match = await indexerDatabase.waitForOrderMatch({
                giveActionIndex: order1AI,
                status: "valid"
            }, 30000)
            assert(match, "Orders with repeating decimal price should match")

            let completed1 = await indexerDatabase.waitForOrder({
                source: address1, giveTick: tokenA, orderStatus: "complete"
            }, 30000)
            assert(completed1, "Order 1 should be complete")

            let completed2 = await indexerDatabase.waitForOrder({
                source: address2, giveTick: tokenB, orderStatus: "complete"
            }, 30000)
            assert(completed2, "Order 2 should be complete")
        })
    })

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
            await gasHelper.mintGas(addr1, 100)
            await gasHelper.mintGas(addr2, 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            let bigOrder = await orderHelper.sendOrderV0(
                addr1,
                COIN_CODE, tokenA, 100,
                COIN_CODE, tokenB, 70,
                address1, expiration,
                null, null, "Large order"
            )
            assert(bigOrder.order, "Big order should exist")
            let bigOrderAI = Number(bigOrder.order["action_index"])

            let smallOrder = await orderHelper.sendOrderV0(
                addr2,
                COIN_CODE, tokenB, 7,
                COIN_CODE, tokenA, 10,
                address2, expiration,
                null, null, "Small counter order"
            )
            assert(smallOrder.order, "Small order should exist")

            let match = await indexerDatabase.waitForOrderMatch({
                giveActionIndex: bigOrderAI,
                status: "valid"
            }, 30000)
            assert(match, "Partial fill match should exist")

            let completedSmall = await indexerDatabase.waitForOrder({
                source: address2, giveTick: tokenB, orderStatus: "complete"
            }, 30000)
            assert(completedSmall, "Small order should be complete")

            let openBig = await indexerDatabase.waitForOrder({
                source: address1, giveTick: tokenA, orderStatus: "open"
            }, 30000)
            assert(openBig, "Big order should still be open after partial fill")
        })
    })

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
            await gasHelper.mintGas(addr1, 100)
            await gasHelper.mintGas(addr2, 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            let order1 = await orderHelper.sendOrderV0(
                addr1,
                COIN_CODE, tokenA, "0.00000003",
                COIN_CODE, tokenB, "1.23456789",
                address1, expiration,
                null, null, "High precision order"
            )
            assert(order1.order, "HP order 1 should exist")
            let order1AI = Number(order1.order["action_index"])

            let order2 = await orderHelper.sendOrderV0(
                addr2,
                COIN_CODE, tokenB, "1.23456789",
                COIN_CODE, tokenA, "0.00000003",
                address2, expiration,
                null, null, "High precision counter"
            )
            assert(order2.order, "HP order 2 should exist")

            let match = await indexerDatabase.waitForOrderMatch({
                giveActionIndex: order1AI,
                status: "valid"
            }, 30000)
            assert(match, "High precision orders should match")

            let completed1 = await indexerDatabase.waitForOrder({
                source: address1, giveTick: tokenA, orderStatus: "complete"
            }, 30000)
            assert(completed1, "HP order 1 should be complete")

            let completed2 = await indexerDatabase.waitForOrder({
                source: address2, giveTick: tokenB, orderStatus: "complete"
            }, 30000)
            assert(completed2, "HP order 2 should be complete")
        })
    })

    describe('v2 - edit', () => {
        it('should create and edit an order', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("ORDER.V2", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let giveTick = "ORDGIVEv2"+address.substring(address.length-8)
            let getTick = "ORDGETv2"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, giveTick, 100, 50, 0, "Order edit give token", 50)
            await issueHelper.sendIssueV0(addr, getTick, 100, 50, 0, "Order edit get token", 50)
            await gasHelper.mintGas(addr, 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let createResult = await orderHelper.sendOrderV0(
                addr,
                COIN_CODE, giveTick, 10,
                COIN_CODE, getTick, 5,
                address,
                Math.floor(expirationDate.getTime() / 1000),
                null, null,
                "Order to edit"
            )
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
