const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const addressHelper = require('../helpers/addressHelper')

describe('ADDRESS', () => {
    describe('v0', () => {
        it('should set address options v0', async () => {
            let addrInfo = await cryptoHelper.getNewFundedAddress("ADDRESS.V0", COIN, NETWORK, null, "legacy", 0, 1)

            let result = await addressHelper.sendAddressV0(
                addrInfo,
                1, // feePreference: 1=destroyed
                0, // requireMemo: 0=not required
                "Address options test"
            )
            assert(result.addressOption, "Address option v0 should exist in DB")
        })
    })
})
