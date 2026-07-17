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

// discoverFeeMode feeschedule-readiness retry : first-file DOGE runs
// after a fresh reset used to fail beforeAll because the single-shot
// feeschedule probe hit the indexer's startup window ('indexer not ready').

const assert = require('assert')

const HELPER_PATH = require.resolve('../../helpers/nativeFeeHelper')

// Fresh module instance per test: the helper caches _feeMode after first
// resolution, so retry behavior is only observable on a clean require.
function freshHelper(){
    delete require.cache[HELPER_PATH]
    return require(HELPER_PATH)
}

describe('nativeFeeHelper.discoverFeeMode', () => {
    const savedEnv = {}
    const ENV_KEYS = ['NATIVE_FEE_DISCOVERY_TIMEOUT_MS', 'NATIVE_FEE_DISCOVERY_POLL_MS', 'FEE_DESTINATION']
    let savedCoin, savedNetwork, savedConnector

    beforeEach(() => {
        for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
        savedCoin = global.COIN_CODE
        savedNetwork = global.NETWORK
        savedConnector = global.indexerConnector
        global.NETWORK = 'regtest'
        // Fast retries so the timeout tests stay sub-second.
        process.env.NATIVE_FEE_DISCOVERY_TIMEOUT_MS = '300'
        process.env.NATIVE_FEE_DISCOVERY_POLL_MS = '20'
    })

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k]
            else process.env[k] = savedEnv[k]
        }
        global.COIN_CODE = savedCoin
        global.NETWORK = savedNetwork
        global.indexerConnector = savedConnector
        delete require.cache[HELPER_PATH]
    })

    it('retries "indexer not ready" on DOGE until feeschedule is populated', async () => {
        global.COIN_CODE = 'DOGE'
        let calls = 0
        global.indexerConnector = { call: async (method) => {
            assert.strictEqual(method, 'feeschedule')
            calls++
            if (calls < 3) return { error: 'indexer not ready' }
            return { nativeFeeEnabled: true, feeDestination: 'DFeeDest111' }
        }}
        const mode = await freshHelper().discoverFeeMode()
        assert.strictEqual(calls, 3)
        assert.deepStrictEqual(mode, { enabled: true, destination: 'DFeeDest111' })
    })

    it('retries connection failures (thrown) on a fee chain', async () => {
        global.COIN_CODE = 'LTC'
        let calls = 0
        global.indexerConnector = { call: async () => {
            calls++
            if (calls < 2) throw new Error('ECONNREFUSED')
            return { nativeFeeEnabled: true, feeDestination: 'LFeeDest111' }
        }}
        const mode = await freshHelper().discoverFeeMode()
        assert.strictEqual(calls, 2)
        assert.deepStrictEqual(mode, { enabled: true, destination: 'LFeeDest111' })
    })

    it('throws after the readiness budget when feeschedule never becomes ready', async () => {
        global.COIN_CODE = 'DOGE'
        let calls = 0
        global.indexerConnector = { call: async () => { calls++; return { error: 'indexer not ready' } } }
        await assert.rejects(
            () => freshHelper().discoverFeeMode(),
            (err) => /native-fee discovery failed on DOGE/.test(err.message) &&
                     /indexer not ready/.test(err.message)
        )
        assert.ok(calls > 1, 'expected multiple attempts, got ' + calls)
    })

    it('does not retry on gas-mode BTC (single probe, falls back to disabled)', async () => {
        global.COIN_CODE = 'BTC'
        let calls = 0
        global.indexerConnector = { call: async () => { calls++; return { error: 'indexer not ready' } } }
        const mode = await freshHelper().discoverFeeMode()
        assert.strictEqual(calls, 1)
        assert.deepStrictEqual(mode, { enabled: false, destination: null })
    })

    it('env FEE_DESTINATION overrides without touching the indexer', async () => {
        global.COIN_CODE = 'DOGE'
        process.env.FEE_DESTINATION = 'DEnvDest111'
        let calls = 0
        global.indexerConnector = { call: async () => { calls++; return {} } }
        const mode = await freshHelper().discoverFeeMode()
        assert.strictEqual(calls, 0)
        assert.deepStrictEqual(mode, { enabled: true, destination: 'DEnvDest111' })
    })

    it('caches the discovered mode (second call makes no further RPC)', async () => {
        global.COIN_CODE = 'DOGE'
        let calls = 0
        global.indexerConnector = { call: async () => {
            calls++
            return { nativeFeeEnabled: true, feeDestination: 'DFeeDest111' }
        }}
        const helper = freshHelper()
        await helper.discoverFeeMode()
        await helper.discoverFeeMode()
        assert.strictEqual(calls, 1)
    })
})
