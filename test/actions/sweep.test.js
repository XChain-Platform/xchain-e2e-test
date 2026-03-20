const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const issueHelper = require('../helpers/issueHelper')
const gasHelper = require('../helpers/gasHelper')
const sweepHelper = require('../helpers/sweepHelper')

describe('SWEEP', () => {
    describe('v0', () => {
        it('should sweep balances to a destination v0', async () => {
            let sourceAddr = await cryptoHelper.getNewFundedAddress("SWEEP.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let destAddr = await cryptoHelper.getNewAddress("SWEEP.V0.DEST", COIN, NETWORK, null, "legacy", 0)
            let tick = "SWEEPv0"+sourceAddr["address"].substring(sourceAddr["address"].length-8)

            // Create a token and mint some gas for fees
            await issueHelper.sendIssueV0(sourceAddr, tick, 100, 50, 0, "Sweep v0 test token", 50)
            await gasHelper.mintGas(sourceAddr, 100)

            // Sweep balances only (no ownerships/escrows)
            let result = await sweepHelper.sendSweepV0(
                sourceAddr,
                destAddr["address"],
                1, // balances
                0, // ownerships
                0, // escrows
                "Sweep test v0"
            )
            assert(result.sweep, "Sweep v0 should exist in DB")
        })
    })
})
