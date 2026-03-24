const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const transactionHelper = require('../transactionHelper')
const issueHelper = require('../helpers/issueHelper')
const dispenserHelper = require('../helpers/dispenserHelper')

describe('DISPENSER', () => {
    describe('v0', () => {
        it('should create a DISPENSER Message v0', async () => {
            let dispenserAddressInfo = await cryptoHelper.getNewFundedAddress("DISPENSER.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let dispenserAddress = dispenserAddressInfo["address"]
            let dispenserTick = "DISPENSERv0"+dispenserAddress.substring(dispenserAddress.length-8)

            await issueHelper.sendIssueV0(dispenserAddressInfo, dispenserTick, 100, 100, 0, "Dispenser v0 test", 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let result = await dispenserHelper.sendDispenserV0(
                dispenserAddressInfo,
                COIN_CODE, dispenserTick, 1, 10,
                COIN_CODE, null, 5, dispenserAddressInfo["address"],
                null, null, Math.floor(expirationDate.getTime() / 1000),
                null, null, 'This is a dispenser v0 test'
            )
            assert(result.dispenser, "Dispenser v0 should exist in DB")
        })
    })

    describe('dispense', () => {
        it('should dispense a token from a dispenser', async () => {
            let dispenserAddressInfo = await cryptoHelper.getNewFundedAddress("DISPENSER.V0.DISPENSE", COIN, NETWORK, null, "legacy", 0, 1)
            let dispenseAddressInfo = await cryptoHelper.getNewFundedAddress("DISPENSE", COIN, NETWORK, null, "legacy", 0, 1)
            let dispenserAddress = dispenserAddressInfo["address"]
            let dispenserTick = "DISPENSERv0DISPENSE"+dispenserAddress.substring(dispenserAddress.length-8)

            await issueHelper.sendIssueV0(dispenserAddressInfo, dispenserTick, 100, 100, 0, "Dispenser v0 test to dispense", 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let dispenserResult = await dispenserHelper.sendDispenserV0(
                dispenserAddressInfo,
                COIN_CODE, dispenserTick, 1, 10,
                COIN_CODE, null, 0.05, dispenserAddressInfo["address"],
                null, null, Math.floor(expirationDate.getTime() / 1000),
                null, null, 'This is a dispenser v0 test to dispense'
            )
            assert(dispenserResult.dispenser, "Dispenser should exist in DB")

            // Get a dispense
            let txHash = await transactionHelper.createSimpleTransaction(
                dispenseAddressInfo, dispenserAddress, 5000000
            )

            // Check if the dispense exists
            console.log("Waiting for DISPENSE in the database (txHash: "+txHash+")...")
            let dispenseRow = await indexerDatabase.waitForDispense({
                txHash: txHash,
                source: dispenseAddressInfo["address"],
                giveCoin: COIN_CODE,
                giveTick: dispenserTick,
                giveAmount: 1,
                getCoin: COIN_CODE,
                getAmount: 0.05,
                destination: dispenseAddressInfo["address"],
                status: "valid"
            }, 60000)

            if (!dispenseRow) {
                // Debug: query without filters
                let debugResult = await indexerDatabase.waitForDispense({ txHash: txHash }, 5000)
                console.log("Debug - dispense by txHash only:", debugResult)
                let debugResult2 = await indexerDatabase.waitForDispense({ source: dispenseAddressInfo["address"] }, 5000)
                console.log("Debug - dispense by source only:", debugResult2)
            }
            assert(dispenseRow, "Dispense should exist in DB")
        })
    })

    describe('v1 - cancel', () => {
        it('should create and cancel a dispenser', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("DISPENSER.V1", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "DISPv1"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, tick, 100, 100, 0, "Dispenser cancel test", 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let createResult = await dispenserHelper.sendDispenserV0(
                addr,
                COIN_CODE, tick, 1, 10,
                COIN_CODE, null, 5, addr["address"],
                null, null, Math.floor(expirationDate.getTime() / 1000),
                null, null, 'Dispenser to cancel'
            )
            assert(createResult.dispenser, "Dispenser should be created")
            let dispenserActionIndex = Number(createResult.dispenser["action_index"])

            // Cancel
            let cancelResult = await dispenserHelper.sendDispenserCancelV1(addr, dispenserActionIndex, "Cancelling dispenser")
            assert(cancelResult.txHash, "Cancel tx should have been sent")

            let closedDispenser = await indexerDatabase.waitForDispenser({
                source: address,
                giveTick: tick,
                status: "cancelled"
            }, 30000)
            assert(closedDispenser, "Dispenser should be cancelled")
        })
    })

    describe('v2 - edit', () => {
        it('should create and edit a dispenser', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("DISPENSER.V2", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "DISPv2"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, tick, 200, 200, 0, "Dispenser edit test", 200)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let createResult = await dispenserHelper.sendDispenserV0(
                addr,
                COIN_CODE, tick, 1, 10,
                COIN_CODE, null, 5, addr["address"],
                null, null, Math.floor(expirationDate.getTime() / 1000),
                null, null, 'Dispenser to edit'
            )
            assert(createResult.dispenser, "Dispenser should be created")
            let dispenserActionIndex = Number(createResult.dispenser["action_index"])

            // Edit: add more escrow
            let newExpiration = new Date()
            newExpiration.setMonth(newExpiration.getMonth() + 6)

            let editResult = await dispenserHelper.sendDispenserEditV2(
                addr, dispenserActionIndex,
                50, Math.floor(newExpiration.getTime() / 1000),
                null, null, "Refilling dispenser"
            )
            assert(editResult.txHash, "Edit tx should have been sent")
        })
    })
})
