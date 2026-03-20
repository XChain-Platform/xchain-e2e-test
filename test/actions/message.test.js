const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const messageHelper = require('../helpers/messageHelper')

describe('MESSAGE', () => {
    describe('v3 - plaintext', () => {
        it('should send a plaintext message v3', async () => {
            let senderAddr = await cryptoHelper.getNewFundedAddress("MESSAGE.V3", COIN, NETWORK, null, "legacy", 0, 1)
            let destAddr = await cryptoHelper.getNewAddress("MESSAGE.V3.DEST", COIN, NETWORK, null, "legacy", 0)

            let result = await messageHelper.sendMessageV3(
                senderAddr,
                destAddr["address"],
                "Hello from XChain e2e test"
            )
            assert(result.message, "Message v3 should exist in DB")
        })
    })
})
