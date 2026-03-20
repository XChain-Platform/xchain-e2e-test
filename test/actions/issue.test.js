const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const issueHelper = require('../helpers/issueHelper')

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
})
