const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const issueHelper = require('../helpers/issueHelper')
const gasHelper = require('../helpers/gasHelper')
const swapHelper = require('../helpers/swapHelper')

describe('SWAP', () => {
    describe('v0 - create', () => {
        it('should create a swap v0', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("SWAP.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let giveTick = "SWPGIVEv0"+address.substring(address.length-8)
            let getTick = "SWPGETv0"+address.substring(address.length-8)

            // Create give and get tokens
            await issueHelper.sendIssueV0(addr, giveTick, 100, 50, 0, "Swap give token", 50)
            await issueHelper.sendIssueV0(addr, getTick, 100, 50, 0, "Swap get token", 50)

            // Mint gas for fee
            await gasHelper.mintGas(addr, 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let result = await swapHelper.sendSwapV0(
                addr,
                COIN_CODE, giveTick, 10,
                COIN_CODE, getTick, 5,
                address,
                Math.floor(expirationDate.getTime() / 1000),
                null, null,
                "Swap test v0"
            )
            assert(result.swap, "Swap v0 should exist in DB")
        })
    })

    describe('v1 - cancel', () => {
        it('should create and cancel a swap', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("SWAP.V1", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let giveTick = "SWPGIVEv1"+address.substring(address.length-8)
            let getTick = "SWPGETv1"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, giveTick, 100, 50, 0, "Swap cancel give token", 50)
            await issueHelper.sendIssueV0(addr, getTick, 100, 50, 0, "Swap cancel get token", 50)
            await gasHelper.mintGas(addr, 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            // Create swap
            let createResult = await swapHelper.sendSwapV0(
                addr,
                COIN_CODE, giveTick, 10,
                COIN_CODE, getTick, 5,
                address,
                Math.floor(expirationDate.getTime() / 1000),
                null, null,
                "Swap to cancel"
            )
            assert(createResult.swap, "Swap should be created")
            let swapActionIndex = Number(createResult.swap["action_index"])

            // Cancel the swap
            let cancelResult = await swapHelper.sendSwapCancelV1(addr, swapActionIndex, "Cancelling swap")
            assert(cancelResult.txHash, "Swap cancel tx should have been sent")

            // Verify original swap is no longer 'open'
            let closedSwap = await indexerDatabase.waitForSwap({
                source: address,
                giveTick: giveTick,
                swapStatus: "closed"
            }, 30000)
            assert(closedSwap, "Swap should be closed after cancel")
        })
    })
})
