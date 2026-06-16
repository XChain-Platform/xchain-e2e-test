'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

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
