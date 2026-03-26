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

            // Create give and get tokens
            await issueHelper.sendIssueV0(addr, giveTick, 100, 50, 0, "Order give token", 50)
            await issueHelper.sendIssueV0(addr, getTick, 100, 50, 0, "Order get token", 50)

            // Mint gas for fee
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

            // Create order
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

            // Cancel the order
            let cancelResult = await orderHelper.sendOrderCancelV1(addr, orderActionIndex, "Cancelling order")
            assert(cancelResult.txHash, "Order cancel tx should have been sent")

            // Verify original order is no longer 'open'
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
            // Two separate addresses — matching requires different SOURCE
            let addr1 = await cryptoHelper.getNewFundedAddress("ORDER.MATCH1", COIN, NETWORK, null, "legacy", 0, 1)
            let addr2 = await cryptoHelper.getNewFundedAddress("ORDER.MATCH2", COIN, NETWORK, null, "legacy", 0, 1)
            let address1 = addr1["address"]
            let address2 = addr2["address"]
            let tokenA = "ORDMA"+address1.substring(address1.length-8)
            let tokenB = "ORDMB"+address1.substring(address1.length-8)

            // addr1 creates both tokens
            await issueHelper.sendIssueV0(addr1, tokenA, 100, 50, 0, "Match token A", 50)
            await issueHelper.sendIssueV0(addr1, tokenB, 100, 50, 0, "Match token B", 50)

            // addr1 sends tokenB to addr2 so addr2 can offer it
            await sendHelper.sendSendV0(addr1, tokenB, 20, address2, "Fund addr2 with tokenB")

            // Both need gas for order fees
            await gasHelper.mintGas(addr1, 100)
            await gasHelper.mintGas(addr2, 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90 // 90 days

            // addr1: GIVE 10 tokenA, GET 5 tokenB
            let order1 = await orderHelper.sendOrderV0(
                addr1,
                COIN_CODE, tokenA, 10,
                COIN_CODE, tokenB, 5,
                address1, expiration,
                null, null, "Selling tokenA for tokenB"
            )
            assert(order1.order, "Order 1 should exist in DB")
            let order1ActionIndex = Number(order1.order["action_index"])

            // addr2: GIVE 5 tokenB, GET 10 tokenA (exact counter-order)
            let order2 = await orderHelper.sendOrderV0(
                addr2,
                COIN_CODE, tokenB, 5,
                COIN_CODE, tokenA, 10,
                address2, expiration,
                null, null, "Buying tokenA with tokenB"
            )
            assert(order2.order, "Order 2 should exist in DB")
            let order2ActionIndex = Number(order2.order["action_index"])

            // Verify the match was created
            let match = await indexerDatabase.waitForOrderMatch({
                giveActionIndex: order1ActionIndex,
                getActionIndex: order2ActionIndex,
                status: "valid"
            }, 30000)
            assert(match, "Order match should exist in DB")

            // Verify both orders are now complete
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

            // Create order
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

            // Edit: extend expiration
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
