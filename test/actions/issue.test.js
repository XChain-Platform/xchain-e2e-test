const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const issueHelper = require('../helpers/issueHelper')
const listHelper = require('../helpers/listHelper')

describe('ISSUE', () => {
    describe('v0', () => {
        it('should create two Issue Messages v0', async () => {
            let issueAddress = await cryptoHelper.getNewFundedAddress("ISSUE.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let newAddress = issueAddress["address"]

            let result1 = await issueHelper.sendIssueV0(
                issueAddress,
                "TESTV0"+newAddress.substring(newAddress.length-8),
                100, 2, 0, "Issuance v0 test", 10
            )
            assert(result1.issue, "First issue v0 should exist in DB")
            assert(result1.credit, "First issue v0 credit should exist in DB")

            let result2 = await issueHelper.sendIssueV0(
                issueAddress,
                "TESTV2"+newAddress.substring(newAddress.length-8),
                100, 5, 0, "2nd Issuance v0 test", 20
            )
            assert(result2.issue, "Second issue v0 should exist in DB")
            assert(result2.credit, "Second issue v0 credit should exist in DB")
        })
    })

    describe('v1', () => {
        it('should create an Issue Message v1', async () => {
            let issueAddress = await cryptoHelper.getNewFundedAddress("ISSUE.V1", COIN, NETWORK, null, "legacy", 0, 1)
            let newAddress = issueAddress["address"]

            let result = await issueHelper.sendIssueV1(
                issueAddress,
                "TEST"+newAddress.substring(newAddress.length-8),
                "Ticker issuance TEST"
            )
            assert(result.issue, "Issue v1 should exist in DB")
        })
    })

    describe('v2 - edit mint params', () => {
        it('should edit mint params of an existing token', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("ISSUE.V2", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "ISSUEv2"+address.substring(address.length-8)

            // Create token first
            await issueHelper.sendIssueV0(addr, tick, 1000, 10, 0, "Issue v2 test", 50)

            // Edit mint params: increase max_mint to 20
            let result = await issueHelper.sendIssueV2(addr, tick, 20, 0, null, null, null, null, "Updating max_mint")
            assert(result.issue, "Issue v2 should exist in DB")
        })
    })

    describe('v3 - edit lock params', () => {
        it('should lock params of an existing token', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("ISSUE.V3", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "ISSUEv3"+address.substring(address.length-8)

            // Create token first — explicitly set lock fields to 0 so the
            // indexer stores them as 0 (not NULL). isValidLock does not
            // handle NULL, so locking a NULL field fails with "(locked)".
            let issueResult = await issueHelper.sendIssueV0(addr, tick, 1000, 10, 0, "Issue v3 test", 50,
                '', '', '', '', 0, 0)
            assert(issueResult.issue, "Initial issue v0 should exist in DB")

            // Lock description and sleep
            let result = await issueHelper.sendIssueV3(addr, tick, null, null, 1, 1, null, null, null, "Locking description and sleep")
            if (!result.issue) {
                let debugResult = await indexerDatabase.waitForIssue({ txHash: result.txHash }, 5000)
                console.log("Debug - issue v3 by txHash only:", debugResult)
            }
            assert(result.issue, "Issue v3 should exist in DB")
        })
    })

    describe('v4 - edit callback params', () => {
        it('should set callback params on an existing token', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("ISSUE.V4", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "ISSUEv4"+address.substring(address.length-8)
            let callbackTick = "ISSUEv4CB"+address.substring(address.length-8)

            // Create both tokens
            await issueHelper.sendIssueV0(addr, tick, 1000, 10, 0, "Issue v4 test", 50)
            await issueHelper.sendIssueV0(addr, callbackTick, 1000, 10, 0, "Callback tick", 100)

            // Set callback params
            let result = await issueHelper.sendIssueV4(addr, tick, 999999, callbackTick, 1, "Setting callback")
            assert(result.issue, "Issue v4 should exist in DB")
        })
    })

    describe('v5 - edit list params', () => {
        it('should set allow/block lists on an existing token', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("ISSUE.V5", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "ISSUEv5"+address.substring(address.length-8)

            // Create token
            await issueHelper.sendIssueV0(addr, tick, 1000, 10, 0, "Issue v5 test", 50)

            // Create an allow list
            let allowAddr = await cryptoHelper.getNewAddress("ISSUE.V5.ALLOW", COIN, NETWORK, null, "legacy", 0)
            let listResult = await listHelper.sendListV0(addr, 2, [allowAddr["address"]])
            assert(listResult.list, "List should be created")
            let allowListActionIndex = Number(listResult.list["action_index"])

            // Set allow list on token
            let result = await issueHelper.sendIssueV5(addr, tick, allowListActionIndex, null, "Setting allow list")
            assert(result.issue, "Issue v5 should exist in DB")
        })
    })
})
