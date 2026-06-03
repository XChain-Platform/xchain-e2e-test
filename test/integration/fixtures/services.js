'use strict'

// Mock JSON-RPC response shapes matching real service contracts.

module.exports = {
    // BlockchainConnector responses (axios)
    node: {
        networkInfo: { data: { result: { version: 250000, subversion: '/Satoshi:25.0.0/' }, error: null, id: 1 } },
        broadcastOk: (txid) => ({ data: { result: txid, error: null, id: 1 } }),
        broadcastFail: (code, msg) => ({ data: { result: null, error: { code, message: msg }, id: 1 } }),
        getRawTx: (hex) => ({ data: { result: { hex }, error: null, id: 1 } }),
        estimateFee: (rate) => ({ data: { result: { feerate: rate }, error: null, id: 1 } }),
        estimateFeeNoRate: { data: { result: { errors: ['Insufficient data'] }, error: null, id: 1 } },
    },

    // XChainEncoderConnector responses (axios)
    encoder: {
        pingOk: { data: { jsonrpc: '2.0', result: true, id: 1 } },
        pingFail: { data: { jsonrpc: '2.0', result: null, id: 1 } },
        createTxOpReturn: (psbtHex) => ({
            data: { jsonrpc: '2.0', result: { encoding: 'opreturn', psbt: psbtHex }, id: 1 }
        }),
        createTxP2SH: (psbtHex) => ({
            data: { jsonrpc: '2.0', result: { encoding: 'P2SH', psbt: psbtHex }, id: 1 }
        }),
    },

    // XChainUtxoTrackerConnector responses (axios)
    utxoTracker: {
        pingOk: { data: { result: true } },
        utxosForAddress: (utxos) => ({ data: { result: { utxos } } }),
        sampleUtxo: (txid, vout, value, confirmations) => ({
            txid: txid || 'aabb' + '00'.repeat(30),
            vout: vout || 0,
            value: value || 100000,
            scriptPubKey: '76a914' + 'aa'.repeat(20) + '88ac',
            confirmations: confirmations != null ? confirmations : 1
        }),
    },

    // RegtestMinerConnector responses (axios)
    miner: {
        pingOk: { data: { jsonrpc: '2.0', result: true, id: 1 } },
        sendFundsOk: (txid) => ({ data: { jsonrpc: '2.0', result: txid, id: 1 } }),
        setMiningTimeOk: { data: { jsonrpc: '2.0', result: true, id: 1 } },
    },

    // XChainIndexerConnector responses (axios)
    indexer: {
        pingOk: { data: { jsonrpc: '2.0', result: true, id: 1 } },
        pingFail: { data: { jsonrpc: '2.0', result: null, id: 1 } },
    },

    // XChainHubConnector responses (axios)
    hub: {
        pingOk: { data: { jsonrpc: '2.0', result: true, id: 1 } },
        configOk: (config) => ({ data: { jsonrpc: '2.0', result: config, id: 1 } }),
    },
}
