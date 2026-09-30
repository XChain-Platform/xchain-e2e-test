'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const path = require('path')
const { resolveCoinEnv, loadCoinEnv, requestedCoin } = require('../../../helpers/rail/coin_env')

// An in-memory directory of env files, so the cases never read the real .env.
function fakeFs(files){
    return {
        existsSync: (p) => Object.prototype.hasOwnProperty.call(files, path.basename(p)),
        readFileSync: (p) => Buffer.from(files[path.basename(p)])
    }
}

const BTC_ENV = 'COIN=bitcoin\nINDEXER_URL=localhost\nINDEXER_API_PORT=3024\nNODE_PORT=3020\nHUB_DB_NAME=XChain_BTC_Regtest_Indexer\n'
const DOGE_ENV = 'COIN=dogecoin\nINDEXER_URL=localhost\nINDEXER_API_PORT=3124\nNODE_PORT=3120\n'

describe('coin_env', function () {
    it('reads the coin from COIN, else from a combined NETWORK', function () {
        assert.strictEqual(requestedCoin({ COIN: 'dogecoin' }), 'dogecoin')
        assert.strictEqual(requestedCoin({ NETWORK: 'litecoin-regtest' }), 'litecoin')
        assert.strictEqual(requestedCoin({ NETWORK: 'regtest' }), null)
    })

    it('loads .env unchanged when the run names its coin or no coin', function () {
        const fs = fakeFs({ '.env': BTC_ENV, '.env.doge': DOGE_ENV })
        for (const env of [{ COIN: 'bitcoin' }, {}]) {
            const d = resolveCoinEnv({ dir: '/r', env, fs })
            assert.strictEqual(path.basename(d.file), '.env')
            assert.strictEqual(d.reason, 'default')
            assert.deepStrictEqual(d.derived, {})
        }
    })

    it('loads only .env.doge for a DOGE run, so no BTC-only key leaks in, and names the BTC indexer', function () {
        const env = { COIN: 'dogecoin' }
        const d = loadCoinEnv({ dir: '/r', env, fs: fakeFs({ '.env': BTC_ENV, '.env.doge': DOGE_ENV }) })
        assert.strictEqual(path.basename(d.file), '.env.doge')
        assert.strictEqual(env.NODE_PORT, '3120')
        assert.strictEqual(env.INDEXER_API_PORT, '3124')
        assert.strictEqual(env.HUB_DB_NAME, undefined, 'a key only .env carries must not reach a DOGE run')
        assert.strictEqual(env.BTC_INDEXER_API_URL, 'http://localhost:3024')
    })

    it('keeps a variable the caller already set, as dotenv does, including the BTC indexer URL', function () {
        const env = { COIN: 'dogecoin', NODE_PORT: '9999', BTC_INDEXER_API_URL: 'http://btc:1' }
        loadCoinEnv({ dir: '/r', env, fs: fakeFs({ '.env': BTC_ENV, '.env.doge': DOGE_ENV }) })
        assert.strictEqual(env.NODE_PORT, '9999')
        assert.strictEqual(env.BTC_INDEXER_API_URL, 'http://btc:1')
    })

    it('falls back to .env with a warning when the coin file is missing', function () {
        const d = resolveCoinEnv({ dir: '/r', env: { COIN: 'litecoin' }, fs: fakeFs({ '.env': BTC_ENV }) })
        assert.strictEqual(path.basename(d.file), '.env')
        assert.strictEqual(d.reason, 'mismatch-no-coin-file')
        assert.match(d.warning, /\.env\.ltc does not exist/)
    })

    it('refuses a coin file that describes another coin', function () {
        assert.throws(() => resolveCoinEnv({ dir: '/r', env: { COIN: 'dogecoin' },
            fs: fakeFs({ '.env': BTC_ENV, '.env.doge': BTC_ENV }) }), /describes bitcoin/)
    })

    it('loads nothing when there is no .env at all', function () {
        const env = { COIN: 'dogecoin' }
        const d = loadCoinEnv({ dir: '/r', env, fs: fakeFs({}) })
        assert.strictEqual(d.file, null)
        assert.deepStrictEqual(Object.keys(env), ['COIN'])
    })
})
