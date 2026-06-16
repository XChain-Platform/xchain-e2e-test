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

    it('should ping the decoder', async () => {
        const result = await decoderConnector.ping()
        assert(result, 'Decoder should respond to ping')
    })

    it('should ping the indexer', async () => {
        const result = await indexerConnector.ping()
        assert(result, 'Indexer should respond to ping')
    })

    it('should ping the explorer', async () => {
        const result = await explorerConnector.ping()
        assert(result, 'Explorer should respond to ping')
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
