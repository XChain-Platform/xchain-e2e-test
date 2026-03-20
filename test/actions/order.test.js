const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const issueHelper = require('../helpers/issueHelper')
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
                status: "closed"
            }, 30000)
            assert(closedOrder, "Order should be closed after cancel")
        })
    })
})
