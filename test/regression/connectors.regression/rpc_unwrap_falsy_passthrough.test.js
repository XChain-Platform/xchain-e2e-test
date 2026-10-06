const assert = require('assert')
const { sinon, mockAxiosPost, RegtestMinerConnector, XChainUtxoTrackerConnector } = require('./support/environment')

void describe('RPC unwrap falsy passthrough (uuid:d944b084)', function () {
    afterEach(function () { sinon.restore() })

    it('[regression:p1] R-CONN-012a : miner unwrap preserves falsy success payloads', async function () {
        const miner = new RegtestMinerConnector('localhost', 5678)
        for (const falsy of [0, '', false]) {
            sinon.restore()
            mockAxiosPost(falsy)
            assert.strictEqual(await miner.sendFunds('addr', 1), falsy)
        }
    })

    // An absent result must throw, since returning null would read as a
    // successful control op; falsy-but-defined passthrough (012a) is unchanged.
    it('[regression:p1] R-CONN-012b : miner unwrap rejects an absent result rather than returning null', async function () {
        const miner = new RegtestMinerConnector('localhost', 5678)
        mockAxiosPost(undefined)
        await assert.rejects(() => miner.sendFunds('addr', 1), /returned no result/)
    })

    it('[regression:p1] R-CONN-012c : tracker status unwraps preserve falsy results', async function () {
        const tracker = new XChainUtxoTrackerConnector('localhost', 2345)
        mockAxiosPost(false)
        assert.strictEqual(await tracker.getQuiescentStatus(), false)
        sinon.restore()
        mockAxiosPost(0)
        assert.strictEqual(await tracker.getSyncStatus(), 0)
    })
})
