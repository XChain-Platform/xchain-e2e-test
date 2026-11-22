'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The nightly xchain-node DOGE and LTC legs run the suite inside the coin's container
// (its port keys are container ports such as tracker 3001) and reach the BTC gas rail
// through BTC_SERVICE_HOST at the published 3020 block. Run 44853786511 failed every
// DOGE and LTC root hook when that layout was read as an isolated rail.

const sinon      = require('sinon')
const assert     = require('assert')
const proxyquire = require('proxyquire')

const XChainHubConnector = require('../../../../src/XChainHubConnector.js')

class FakeDatabase { constructor(host, port, name, user, pass) { Object.assign(this, { host, port, name, user, pass }) } }
const chainRail = proxyquire('../../../helpers/chainRail', { '../../src/db.js': FakeDatabase })

const HUB_KEYS = ['HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS']
const PORT_KEYS = ['NODE_PORT', 'UTXO_TRACKER_API_PORT', 'DECODER_API_PORT',
    'ENCODER_API_PORT', 'INDEXER_API_PORT', 'REGTEST_MINER_API_PORT']
const CONTAINER_PORTS = ['19443', '3001', '3002', '3003', '3004', '3005']
const SAVED = [...HUB_KEYS, ...PORT_KEYS, ...PORT_KEYS.map((key) => 'BTC_' + key), 'BTC_SERVICE_HOST']
const HUB_CONFIG = {
    bitcoin: { regtest: {
        node: { user: 'rpcuser', pass: 'rpcpass' },
        'xchain-indexer': { name: 'XChain_BTC_Regtest_Indexer', user: 'btc_user', pass: 'dbpass' },
    } },
}

describe('chainRail: the nightly CI container stack', function () {
    const savedEnv = {}
    let savedCoinCode

    beforeEach(function () {
        savedCoinCode = global.COIN_CODE
        global.COIN_CODE = 'LTC'
        for (const key of SAVED) { savedEnv[key] = process.env[key]; delete process.env[key] }
        PORT_KEYS.forEach((key, i) => { process.env[key] = CONTAINER_PORTS[i] })
        for (const key of HUB_KEYS) process.env[key] = 'ci-' + key.toLowerCase()
        process.env.BTC_SERVICE_HOST = '172.17.0.1'
        sinon.stub(XChainHubConnector.prototype, 'ping').resolves(true)
        sinon.stub(XChainHubConnector.prototype, 'getAllConfig').resolves(HUB_CONFIG)
    })

    afterEach(function () {
        sinon.restore()
        global.COIN_CODE = savedCoinCode
        for (const key of SAVED) {
            if (savedEnv[key] === undefined) delete process.env[key]
            else process.env[key] = savedEnv[key]
        }
    })

    it('reaches the routed BTC rail on its published defaults and keeps the shared hub DB', async function () {
        const rail = await chainRail.createRail('bitcoin', 'regtest')
        const seen = {}
        await chainRail.withRail(rail, async () => {
            for (const key of HUB_KEYS) seen[key] = process.env[key]
        })

        assert.strictEqual(rail.host, '172.17.0.1')
        assert.deepStrictEqual(rail.ports, {
            node: 3020, tracker: 3021, decoder: 3022, encoder: 3023,
            indexer: 3024, miner: 3025, explorer: 18080,
        })
        for (const key of HUB_KEYS) assert.strictEqual(seen[key], 'ci-' + key.toLowerCase(), key)
    })

    it('still refuses the shared BTC defaults when no rail is routed', async function () {
        delete process.env.BTC_SERVICE_HOST
        await assert.rejects(
            chainRail.createRail('bitcoin', 'regtest'),
            /isolated LTC rail cannot use shared BTC port 3020; set BTC_NODE_PORT/)
    })
})
