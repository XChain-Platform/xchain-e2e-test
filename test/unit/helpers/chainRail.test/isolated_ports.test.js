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

describe('chainRail: isolated rail ports', function () {
    const savedEnv = {}
    let savedCoinCode

    beforeEach(function () {
        savedCoinCode = global.COIN_CODE
        global.COIN_CODE = 'DOGE'
        for (const key of PORT_KEYS) {
            savedEnv[key] = process.env[key]
            savedEnv['BTC_' + key] = process.env['BTC_' + key]
            delete process.env['BTC_' + key]
        }
        PORT_KEYS.forEach((key, i) => { process.env[key] = DOGE_PORTS[i] })
        sinon.stub(XChainHubConnector.prototype, 'ping').resolves(true)
        sinon.stub(XChainHubConnector.prototype, 'getAllConfig').resolves(HUB_CONFIG)
    })

    afterEach(function () {
        sinon.restore()
        global.COIN_CODE = savedCoinCode
        for (const key of PORT_KEYS) {
            for (const name of [key, 'BTC_' + key]) {
                if (savedEnv[name] === undefined) delete process.env[name]
                else process.env[name] = savedEnv[name]
            }
        }
    })

    it('keeps shared BTC defaults when every active DOGE port is the shared default', async function () {
        const rail = await chainRail.createRail('bitcoin', 'regtest')
        assert.deepStrictEqual(rail.ports, {
            node: 3020, tracker: 3021, decoder: 3022, encoder: 3023,
            indexer: 3024, miner: 3025, explorer: 18080,
        })
    })

    it('names a missing BTC port instead of falling back to the shared rail from an isolated rail', async function () {
        process.env.INDEXER_API_PORT = '4124'
        PORT_KEYS.forEach((key, i) => { process.env['BTC_' + key] = BTC_PORTS[i] })
        delete process.env.BTC_INDEXER_API_PORT

        await assert.rejects(
            chainRail.createRail('bitcoin', 'regtest'),
            /isolated DOGE rail.*BTC_INDEXER_API_PORT/)
    })

    it('uses explicit BTC ports from an isolated DOGE rail', async function () {
        process.env.INDEXER_API_PORT = '4124'
        PORT_KEYS.forEach((key, i) => { process.env['BTC_' + key] = BTC_PORTS[i] })

        const rail = await chainRail.createRail('bitcoin', 'regtest')
        assert.deepStrictEqual(rail.ports, {
            node: 4020, tracker: 4021, decoder: 4022, encoder: 4023,
            indexer: 4024, miner: 4025, explorer: 18080,
        })
    })
})
