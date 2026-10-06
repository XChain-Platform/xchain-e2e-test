const assert = require('assert')
const { BlockchainConnector, XChainUtxoTrackerConnector, XChainEncoderConnector, XChainIndexerConnector, XChainHubConnector, RegtestMinerConnector } = require('./support/environment')

void describe('Constructor URL building', function () {

    it('[regression:p0] R-CONN-011c : all connectors build URL from host and port', function () {
        const node    = new BlockchainConnector('myhost', 1234, 'u', 'p')
        const tracker = new XChainUtxoTrackerConnector('myhost', 2345)
        const encoder = new XChainEncoderConnector('myhost', 3456)
        const indexer = new XChainIndexerConnector('myhost', 4567)
        const miner   = new RegtestMinerConnector('myhost', 5678)

        assert.strictEqual(node.url, 'http://myhost:1234')
        assert.strictEqual(tracker.url, 'http://myhost:2345')
        assert.strictEqual(encoder.url, 'http://myhost:3456')
        assert.strictEqual(indexer.url, 'http://myhost:4567')
        assert.strictEqual(miner.url, 'http://myhost:5678')
    })

    it('[regression:p0] R-CONN-011d : HubConnector accepts array of endpoints', function () {
        const hub = new XChainHubConnector(['http://a:1', 'http://b:2'])
        assert.deepStrictEqual(hub.urls, ['http://a:1', 'http://b:2'])
    })

    it('[regression:p0] R-CONN-011e : HubConnector accepts host+port for backward compat', function () {
        const hub = new XChainHubConnector('myhost', 9999)
        assert.deepStrictEqual(hub.urls, ['http://myhost:9999'])
    })
})
