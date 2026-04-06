'use strict'

// Mock hub config response matching the real getAllConfig() structure.
// Keys: hubConfigs[coin][network][service][param]
module.exports = {
    validConfig: {
        bitcoin: {
            regtest: {
                node: {
                    host: 'node-host',
                    server_port: 18443,
                    user: 'rpcuser',
                    pass: 'rpcpass'
                },
                database: {
                    host: 'db-host',
                    port: 3306
                },
                'xchain-utxo-tracker': {
                    host: 'utxo-host',
                    server_port: 3030
                },
                'xchain-encoder': {
                    host: 'encoder-host',
                    server_port: 3031
                },
                'xchain-indexer': {
                    host: 'indexer-host',
                    server_port: 3032,
                    name: 'XChain_BTC_Regtest_Indexer',
                    user: 'indexer_user',
                    pass: 'indexer_pass'
                },
                'xchain-regtest-miner': {
                    host: 'miner-host',
                    server_port: 3033
                }
            }
        }
    }
}
