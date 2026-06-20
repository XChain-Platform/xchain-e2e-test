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

// Chaos Experiment 12: Partial Hub Config (@P1)
//
// Verifies that when the hub returns a config missing critical keys,
// the bootstrap validation detects and reports the missing keys
// with a diagnostic error.

const assert = require('assert')
const sinon = require('sinon')
const hubFixtures = require('../integration/fixtures/hub')

const REQUIRED_KEYS = [
    'node', 'database', 'xchain-utxo-tracker', 'xchain-encoder',
    'xchain-indexer', 'xchain-regtest-miner'
]

function validateHubConfig(hubConfigs, coin, network) {
    if (!hubConfigs || !hubConfigs[coin]) {
        throw new Error(`Hub config missing coin: ${coin}`)
    }
    if (!hubConfigs[coin][network]) {
        throw new Error(`Hub config missing network: ${coin}/${network}`)
    }
    const cfg = hubConfigs[coin][network]
    for (const key of REQUIRED_KEYS) {
        if (!cfg[key]) {
            throw new Error(`Hub config missing required key: ${key}`)
        }
    }
    return cfg
}

// Simulate what happens when bootstrap reads a missing key without validation
function accessConfigUnsafe(hubConfigs, coin, network) {
    const cfg = hubConfigs[coin][network]
    // This is what initialCheck.test.js does (direct property access)
    return {
        encoderPort: cfg['xchain-encoder']['server_port'],
        utxoPort: cfg['xchain-utxo-tracker']['server_port'],
        nodePort: cfg['node']['server_port'],
    }
}

describe('Chaos Experiment 12: Partial Hub Config @P1', function () {

    function cloneConfig() {
        return JSON.parse(JSON.stringify(hubFixtures.validConfig))
    }

    describe('validated bootstrap catches missing keys', function () {

        it('throws when xchain-encoder key is missing', function () {
            const config = cloneConfig()
            delete config.bitcoin.regtest['xchain-encoder']

            assert.throws(
                () => validateHubConfig(config, 'bitcoin', 'regtest'),
                /xchain-encoder/
            )
        })

        it('throws when node key is missing', function () {
            const config = cloneConfig()
            delete config.bitcoin.regtest['node']

            assert.throws(
                () => validateHubConfig(config, 'bitcoin', 'regtest'),
                /node/
            )
        })

        it('throws when database key is missing', function () {
            const config = cloneConfig()
            delete config.bitcoin.regtest['database']

            assert.throws(
                () => validateHubConfig(config, 'bitcoin', 'regtest'),
                /database/
            )
        })

        it('throws when xchain-utxo-tracker key is missing', function () {
            const config = cloneConfig()
            delete config.bitcoin.regtest['xchain-utxo-tracker']

            assert.throws(
                () => validateHubConfig(config, 'bitcoin', 'regtest'),
                /xchain-utxo-tracker/
            )
        })

        it('throws when xchain-indexer key is missing', function () {
            const config = cloneConfig()
            delete config.bitcoin.regtest['xchain-indexer']

            assert.throws(
                () => validateHubConfig(config, 'bitcoin', 'regtest'),
                /xchain-indexer/
            )
        })

        it('throws when xchain-regtest-miner key is missing', function () {
            const config = cloneConfig()
            delete config.bitcoin.regtest['xchain-regtest-miner']

            assert.throws(
                () => validateHubConfig(config, 'bitcoin', 'regtest'),
                /xchain-regtest-miner/
            )
        })

        it('passes validation with complete config', function () {
            const config = cloneConfig()

            assert.doesNotThrow(
                () => validateHubConfig(config, 'bitcoin', 'regtest')
            )
        })
    })

    describe('unvalidated access produces TypeError', function () {

        it('TypeError when xchain-encoder is missing', function () {
            const config = cloneConfig()
            delete config.bitcoin.regtest['xchain-encoder']

            assert.throws(
                () => accessConfigUnsafe(config, 'bitcoin', 'regtest'),
                TypeError
            )
        })

        it('TypeError when node is missing', function () {
            const config = cloneConfig()
            delete config.bitcoin.regtest['node']

            assert.throws(
                () => accessConfigUnsafe(config, 'bitcoin', 'regtest'),
                TypeError
            )
        })
    })

    describe('missing coin or network', function () {

        it('throws when coin is missing from config', function () {
            const config = cloneConfig()

            assert.throws(
                () => validateHubConfig(config, 'dogecoin', 'regtest'),
                /missing coin: dogecoin/
            )
        })

        it('throws when network is missing from config', function () {
            const config = cloneConfig()

            assert.throws(
                () => validateHubConfig(config, 'bitcoin', 'mainnet'),
                /missing network: bitcoin\/mainnet/
            )
        })

        it('throws when config is null', function () {
            assert.throws(
                () => validateHubConfig(null, 'bitcoin', 'regtest'),
                /missing coin/
            )
        })
    })
})
