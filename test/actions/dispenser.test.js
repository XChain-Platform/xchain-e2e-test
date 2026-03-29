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

    describe('dispense - balance verification', () => {
        it('should credit recipient and debit dispenser after dispense', async () => {
            let dispenserAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.BAL", COIN, NETWORK, null, "legacy", 0, 1)
            let buyerAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.BAL.BUYER", COIN, NETWORK, null, "legacy", 0, 1)
            let dispenserAddress = dispenserAddr["address"]
            let buyerAddress = buyerAddr["address"]
            let tick = "DISPBALv0"+dispenserAddress.substring(dispenserAddress.length-8)

            // Issue token with 4 decimals, escrow 50 units in dispenser
            await issueHelper.sendIssueV0(dispenserAddr, tick, 100, 100, 4, "Dispenser balance test", 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            // Dispenser: give 2.5000 tokens per 0.001 BTC (100000 sats)
            let dispenserResult = await dispenserHelper.sendDispenserV0(
                dispenserAddr,
                COIN_CODE, tick, "2.5", 50,
                COIN_CODE, null, 0.001, dispenserAddr["address"],
                null, null, expiration,
                null, null, 'Balance verification dispenser'
            )
            assert(dispenserResult.dispenser, "Dispenser should be created")

            // Buyer sends 0.002 BTC (200000 sats) -> should get 2 * 2.5 = 5.0000 tokens
            let txHash = await transactionHelper.createSimpleTransaction(
                buyerAddr, dispenserAddress, 200000
            )

            console.log("Waiting for DISPENSE in the database...")
            let dispenseRow = await indexerDatabase.waitForDispense({
                txHash: txHash,
                source: buyerAddress,
                giveTick: tick,
                status: "valid"
            }, 60000)
            assert(dispenseRow, "Dispense should exist in DB")

            // Verify buyer received credit
            let credit = await indexerDatabase.waitForCredit({
                address: buyerAddress,
                tick: tick,
                amount: "5"
            }, 30000)
            assert(credit, "Buyer should be credited 5 tokens")

            // Verify dispenser was debited
            let debit = await indexerDatabase.waitForDebit({
                address: dispenserAddress,
                tick: tick,
                amount: "5"
            }, 30000)
            assert(debit, "Dispenser should be debited 5 tokens")
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

            let cancellingDispenser = await indexerDatabase.waitForDispenserStatus({
                dispenserActionIndex: dispenserActionIndex,
                status: "cancelling"
            }, 30000)
            assert(cancellingDispenser, "Dispenser should be cancelling")
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
