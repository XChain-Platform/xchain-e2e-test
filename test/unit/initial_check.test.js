'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// initialCheck.js has deep side effects at require-time (MariaDB, coin nodes,
// connector classes) that require live services. These tests verify the pure
// COIN_CODE_MAP logic and NETWORK-splitting inline, without requiring the module.

const assert = require('assert');

// Inline the exact logic from initialCheck.js so we can test it in isolation.
const COIN_CODE_MAP = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' };
function getCoinCode(coin) {
    return COIN_CODE_MAP[coin] || coin.toUpperCase().slice(0, 3);
}

describe('initialCheck: COIN_CODE_MAP logic', function () {

    describe('getCoinCode (COIN_CODE_MAP lookup + fallback)', function () {

        it('returns "BTC" for coin "bitcoin"', function () {
            assert.strictEqual(getCoinCode('bitcoin'), 'BTC');
        });

        it('returns "LTC" for coin "litecoin"', function () {
            assert.strictEqual(getCoinCode('litecoin'), 'LTC');
        });

        it('returns "DOGE" for coin "dogecoin"', function () {
            assert.strictEqual(getCoinCode('dogecoin'), 'DOGE');
        });

        it('falls back to first 3 chars uppercased for an unknown coin "namecoin"', function () {
            assert.strictEqual(getCoinCode('namecoin'), 'NAM');
        });

        it('falls back to first 3 chars uppercased for "zcash"', function () {
            assert.strictEqual(getCoinCode('zcash'), 'ZCA');
        });

        it('falls back to first 3 chars uppercased for a short unknown coin "ab"', function () {
            // slice(0, 3) on a 2-char string returns all 2 chars
            assert.strictEqual(getCoinCode('ab'), 'AB');
        });

        it('the map contains exactly the three documented entries', function () {
            const keys = Object.keys(COIN_CODE_MAP);
            assert.deepStrictEqual(keys.sort(), ['bitcoin', 'dogecoin', 'litecoin']);
        });
    });
});

// When COIN is not set, initialCheck.js splits NETWORK on "-":
    //   let networkSplit = NETWORK.split("-")
    //   global.COIN = networkSplit[0]
    //   global.NETWORK = networkSplit[1]

describe('initialCheck: COIN_CODE_MAP logic', function () {
    describe('NETWORK splitting fallback (when COIN is absent)', function () {
        function splitNetwork(network) {
            const parts = network.split('-');
            return { coin: parts[0], network: parts[1] };
        }

        it('splits "bitcoin-regtest" into coin=bitcoin, network=regtest', function () {
            const r = splitNetwork('bitcoin-regtest');
            assert.strictEqual(r.coin,    'bitcoin');
            assert.strictEqual(r.network, 'regtest');
        });

        it('splits "litecoin-mainnet" into coin=litecoin, network=mainnet', function () {
            const r = splitNetwork('litecoin-mainnet');
            assert.strictEqual(r.coin,    'litecoin');
            assert.strictEqual(r.network, 'mainnet');
        });

        it('splits "dogecoin-testnet" into coin=dogecoin, network=testnet', function () {
            const r = splitNetwork('dogecoin-testnet');
            assert.strictEqual(r.coin,    'dogecoin');
            assert.strictEqual(r.network, 'testnet');
        });
    });
});

// Leave mochaHooks.beforeAll / afterAll out of this tier: they bootstrap and ping
// every global connector against live Docker services and a regtest network.
// Every e2e script loads them with --require, and test/unit/setup/teardown.test.js
// covers the afterAll miner reset with stubs (no pending marker, which never runs).
