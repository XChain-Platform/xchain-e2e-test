const sinon  = require('sinon')

// Set up globals for transactionHelper (used by action helpers)
global.wallets               = {}
global.NETWORK_OBJECT        = require('bitcoinjs-lib').networks.regtest
global.encoderConnector      = { createTx: async () => ({}) }
global.nodeConnector         = { broadcastTx: async () => 'txhash-stub', waitForTx: async () => true }
global.utxoTrackerConnector  = { getUtxosFromAddress: async () => ({ utxos: [] }), waitForUtxos: async () => true }
global.regtestMinerConnector = { sendFunds: async () => 'txid-stub' }
global.indexerDatabase       = {
    waitForIssue:   sinon.stub().resolves({ tick: 'TOKR', status: 'valid' }),
    waitForSend:    sinon.stub().resolves({ tick: 'TOKR', status: 'valid' }),
    waitForCredit:  sinon.stub().resolves({ tick: 'TOKR', amount: '100' }),
    waitForDebit:   sinon.stub().resolves({ tick: 'TOKR', amount: '100' }),
    waitForMint:    sinon.stub().resolves({ tick: 'TOKR', status: 'valid' }),
    waitForDestroy: sinon.stub().resolves({ tick: 'TOKR', status: 'valid' }),
    waitForBatch:   sinon.stub().resolves({ status: 'valid' }),
    waitForSweep:   sinon.stub().resolves({ status: 'valid' }),
}

const transactionHelper = require('../../../transactionHelper')
const issueHelper       = require('../../../helpers/issueHelper')
const sendHelper        = require('../../../helpers/sendHelper')

module.exports = { transactionHelper, issueHelper, sendHelper }
