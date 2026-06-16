// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')

describe('SMOKE: Bootstrap', () => {
    it('should have loaded environment variables', () => {
        assert(global.COIN, 'COIN global should be set')
        assert(global.NETWORK, 'NETWORK global should be set')
        assert(global.COIN_CODE, 'COIN_CODE global should be set')
        assert(global.NETWORK_OBJECT, 'NETWORK_OBJECT global should be set')

        const validCoins = ['bitcoin', 'litecoin', 'dogecoin']
        assert(validCoins.includes(COIN), 'COIN should be bitcoin, litecoin, or dogecoin, got: ' + COIN)

        const validNetworks = ['mainnet', 'testnet', 'regtest']
        assert(validNetworks.includes(NETWORK), 'NETWORK should be mainnet, testnet, or regtest, got: ' + NETWORK)
    })

    it('should have initialized all global connectors', () => {
        assert(global.nodeConnector, 'nodeConnector should be initialized')
        assert(global.utxoTrackerConnector, 'utxoTrackerConnector should be initialized')
        assert(global.encoderConnector, 'encoderConnector should be initialized')
        assert(global.decoderConnector, 'decoderConnector should be initialized')
        assert(global.indexerConnector, 'indexerConnector should be initialized')
        assert(global.explorerConnector, 'explorerConnector should be initialized')
        assert(global.indexerDatabase, 'indexerDatabase should be initialized')
        assert(global.regtestMinerConnector, 'regtestMinerConnector should be initialized')
    })
})
