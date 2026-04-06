const assert = require('assert')

describe('SMOKE: Regtest Mining', () => {
    it('should be able to configure mining timing', async () => {
        const result = await regtestMinerConnector.setMiningTime(1000, 1000)
        assert(result !== null && result !== undefined, 'setMiningTime should return a result')
    })

    it('should be able to send funds to a new address', async () => {
        const cryptoHelper = require('../cryptoHelper')
        const addressInfo = await cryptoHelper.getNewAddress(
            'SMOKE.MINING', COIN, NETWORK, null, 'legacy', 0
        )

        const txId = await regtestMinerConnector.sendFunds(addressInfo.address, 1)
        assert(txId, 'sendFunds should return a transaction ID')

        const txExists = await nodeConnector.waitForTx(txId, 30000)
        assert(txExists, 'Funded transaction should appear in the blockchain')
    })
})
