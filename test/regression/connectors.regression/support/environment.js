const sinon = require('sinon')
const axios = require('axios')

const BlockchainConnector        = require('../../../../src/blockchain_connector')
const XChainUtxoTrackerConnector = require('../../../../src/XChainUtxoTrackerConnector')
const XChainEncoderConnector     = require('../../../../src/XChainEncoderConnector')
const XChainIndexerConnector     = require('../../../../src/XChainIndexerConnector')
const XChainHubConnector         = require('../../../../src/XChainHubConnector')
const RegtestMinerConnector      = require('../../../../src/regtest_miner_connector')

function mockAxiosPost(result) {
    return sinon.stub(axios, 'post').resolves({
        data: { jsonrpc: '2.0', result, id: 1 }
    })
}

module.exports = {
    sinon, axios, mockAxiosPost,
    BlockchainConnector, XChainUtxoTrackerConnector, XChainEncoderConnector,
    XChainIndexerConnector, XChainHubConnector, RegtestMinerConnector,
}
