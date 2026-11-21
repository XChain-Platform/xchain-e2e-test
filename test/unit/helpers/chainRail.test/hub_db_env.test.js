'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon      = require('sinon')
const assert     = require('assert')
const proxyquire = require('proxyquire')

const XChainHubConnector = require('../../../../src/XChainHubConnector.js')

class FakeDatabase { constructor(host, port, name, user, pass) { Object.assign(this, { host, port, name, user, pass }) } }
const chainRail = proxyquire('../../../helpers/chainRail', { '../../src/db.js': FakeDatabase })

const HUB_KEYS = ['HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS',
    'HUB_SOURCE_DB_HOST', 'HUB_SOURCE_DB_PORT', 'HUB_SOURCE_DB_NAME',
    'HUB_SOURCE_DB_USER', 'HUB_SOURCE_DB_PASS']
const PORT_KEYS = ['NODE_PORT', 'UTXO_TRACKER_API_PORT', 'DECODER_API_PORT',
    'ENCODER_API_PORT', 'INDEXER_API_PORT', 'REGTEST_MINER_API_PORT']
const DOGE_PORTS = ['3120', '3121', '3122', '3123', '3124', '3125']
const BTC_PORTS = ['4020', '4021', '4022', '4023', '4024', '4025']
const HUB_CONFIG = {
    bitcoin: { regtest: {
        node: { user: 'rpcuser', pass: 'rpcpass' },
        'xchain-indexer': { name: 'XChain_BTC_Regtest_Indexer', user: 'btc_user', pass: 'dbpass' },
    } },
}

describe('chainRail: the rail owns hub database coordinates', function () {
    const savedEnv = {}
    let savedCoinCode

    beforeEach(function () {
        savedCoinCode = global.COIN_CODE
        global.COIN_CODE = 'DOGE'
        for (const key of HUB_KEYS) {
            savedEnv[key] = process.env[key]
            savedEnv['BTC_' + key] = process.env['BTC_' + key]
            process.env[key] = 'doge-' + key.toLowerCase()
            delete process.env['BTC_' + key]
        }
        for (const [i, key] of PORT_KEYS.entries()) {
            savedEnv[key] = process.env[key]
            savedEnv['BTC_' + key] = process.env['BTC_' + key]
            process.env[key] = DOGE_PORTS[i]
            delete process.env['BTC_' + key]
        }
        sinon.stub(XChainHubConnector.prototype, 'ping').resolves(true)
        sinon.stub(XChainHubConnector.prototype, 'getAllConfig').resolves(HUB_CONFIG)
    })

    afterEach(function () {
        sinon.restore()
        global.COIN_CODE = savedCoinCode
        for (const key of [...HUB_KEYS, ...PORT_KEYS]) {
            const names = [key, 'BTC_' + key]
            for (const name of names) {
                if (savedEnv[name] === undefined) delete process.env[name]
                else process.env[name] = savedEnv[name]
            }
        }
    })

    function isolateActiveRail() {
        process.env.INDEXER_API_PORT = '4124'
        PORT_KEYS.forEach((key, i) => { process.env['BTC_' + key] = BTC_PORTS[i] })
    }

    it('installs target values on an isolated rail and restores the active rail', async function () {
        isolateActiveRail()
        for (const key of HUB_KEYS) process.env['BTC_' + key] = 'btc-' + key.toLowerCase()
        const rail = await chainRail.createRail('bitcoin', 'regtest')
        const seen = {}

        await chainRail.withRail(rail, async () => {
            for (const key of HUB_KEYS) seen[key] = process.env[key]
        })

        for (const key of HUB_KEYS) {
            assert.strictEqual(seen[key], 'btc-' + key.toLowerCase(), key + ' inside BTC rail')
            assert.strictEqual(process.env[key], 'doge-' + key.toLowerCase(), key + ' restored')
        }
    })

    it('clears active DOGE coordinates on an isolated rail when BTC has none', async function () {
        isolateActiveRail()
        const rail = await chainRail.createRail('bitcoin', 'regtest')
        const seen = {}

        await chainRail.withRail(rail, async () => {
            for (const key of HUB_KEYS) seen[key] = process.env[key]
        })

        for (const key of HUB_KEYS) {
            assert.strictEqual(seen[key], undefined, key + ' must fall back to the BTC indexer DB')
            assert.strictEqual(process.env[key], 'doge-' + key.toLowerCase(), key + ' restored')
        }
    })

    it('keeps generic coordinates unchanged on the shared rail when BTC has none', async function () {
        const rail = await chainRail.createRail('bitcoin', 'regtest')
        const seen = {}

        await chainRail.withRail(rail, async () => {
            for (const key of HUB_KEYS) seen[key] = process.env[key]
        })

        for (const key of HUB_KEYS) {
            assert.strictEqual(seen[key], 'doge-' + key.toLowerCase(), key + ' retained on shared rail')
            assert.strictEqual(process.env[key], 'doge-' + key.toLowerCase(), key + ' restored')
        }
    })
})
