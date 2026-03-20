const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const issueHelper = require('../helpers/issueHelper')
const destroyHelper = require('../helpers/destroyHelper')

describe('DESTROY', () => {
    describe('v0', () => {
        it('should destroy tokens v0', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("DESTROY.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let tick = "DESTROYv0"+addr["address"].substring(addr["address"].length-8)

            // Issue a token with supply
            await issueHelper.sendIssueV0(addr, tick, 100, 50, 0, "Destroy v0 test token", 50)

            // Destroy some of it
            let result = await destroyHelper.sendDestroyV0(addr, tick, 10, "Destroying 10 tokens")
            assert(result.destroy, "Destroy v0 should exist in DB")
            assert(result.debit, "Destroy v0 debit should exist in DB")
        })
    })
})
