const assert = require('assert')

describe('SMOKE: Service Connectivity', () => {
    it('should ping the blockchain node', async () => {
        const info = await nodeConnector.getNetworkInfo()
        assert(info, 'Blockchain node should respond to getNetworkInfo')
    })

    it('should ping the UTXO tracker', async () => {
        const result = await utxoTrackerConnector.ping()
        assert(result, 'UTXO tracker should respond to ping')
    })

    it('should ping the encoder', async () => {
        const result = await encoderConnector.ping()
        assert(result, 'Encoder should respond to ping')
    })

    it('should ping the indexer', async () => {
        const result = await indexerConnector.ping()
        assert(result, 'Indexer should respond to ping')
    })

    it('should ping the indexer database', async () => {
        const result = await indexerDatabase.ping()
        assert(result, 'Indexer database should respond to ping')
    })

    it('should ping the regtest miner', async () => {
        const result = await regtestMinerConnector.ping()
        assert(result, 'Regtest miner should respond to ping')
    })
})
