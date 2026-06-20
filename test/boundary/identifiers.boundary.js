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

// Boundary tests for identifier and string handling across the test suite:
// wallet labels, tick names, txHash values, addressIndex, and filter values.

const assert = require('assert')
const sinon = require('sinon')

const CryptoNetworks = require('../../src/CryptoNetworks')

global.wallets = {}
global.regtestMinerConnector = { sendFunds: async () => 'txid-stub' }
global.nodeConnector = { waitForTx: async () => true }
global.utxoTrackerConnector = { waitForUtxos: async () => true }

const cryptoHelper = require('../cryptoHelper')

describe('Boundary: Identifiers & Strings', function () {

    beforeEach(function () {
        global.wallets = {}
    })

    afterEach(function () {
        sinon.restore()
        global.wallets = {}
    })

    describe('IS-01: getWallet with empty string label', function () {

        it('creates and caches a wallet under the empty string key', async function () {
            const wallet = await cryptoHelper.getWallet('')

            assert.ok(wallet, 'should return a wallet object')
            assert.strictEqual(wallet.mnemonic, null)
            assert.deepStrictEqual(wallet.addresses, [])
            assert.ok('' in global.wallets, 'empty string key should exist in wallets')
        })

        it('returns the same wallet on repeated calls with empty label', async function () {
            const first = await cryptoHelper.getWallet('')
            const second = await cryptoHelper.getWallet('')

            assert.strictEqual(first, second, 'should return cached wallet')
        })
    })

    describe('IS-02: getWallet idempotency', function () {

        it('returns the same object for the same label', async function () {
            const first = await cryptoHelper.getWallet('ISSUE.V0')
            first.mnemonic = 'test-mnemonic'

            const second = await cryptoHelper.getWallet('ISSUE.V0')

            assert.strictEqual(second.mnemonic, 'test-mnemonic',
                'cached wallet should retain mutations')
            assert.strictEqual(first, second)
        })
    })

    describe('IS-03: getWallet with special characters in label', function () {

        it('handles label with slashes, dots, and symbols', async function () {
            const label = 'issue/v0.test@#$%^&*()'
            const wallet = await cryptoHelper.getWallet(label)

            assert.ok(wallet)
            assert.ok(label in global.wallets)
        })

        it('handles label with unicode characters', async function () {
            const label = 'wallet-\u00e9\u00e8\u00ea-\u4e16\u754c'
            const wallet = await cryptoHelper.getWallet(label)

            assert.ok(wallet)
            assert.ok(label in global.wallets)
        })

        it('handles label with spaces and tabs', async function () {
            const label = 'my wallet\tlabel'
            const wallet = await cryptoHelper.getWallet(label)

            assert.ok(wallet)
            assert.ok(label in global.wallets)
        })
    })

    describe('IS-04: getWallet with very long label', function () {

        it('handles 10000-character label without error', async function () {
            const label = 'A'.repeat(10000)
            const wallet = await cryptoHelper.getWallet(label)

            assert.ok(wallet)
            assert.ok(label in global.wallets)
            assert.strictEqual(wallet.mnemonic, null)
        })
    })

    describe('IS-05: Similar labels do not collide', function () {

        it('treats "abc" and "ABC" as different wallets', async function () {
            const lower = await cryptoHelper.getWallet('abc')
            const upper = await cryptoHelper.getWallet('ABC')

            assert.notStrictEqual(lower, upper, 'case-different labels should be separate wallets')
        })

        it('treats "wallet.0" and "wallet.0 " (trailing space) as different', async function () {
            const noSpace = await cryptoHelper.getWallet('wallet.0')
            const withSpace = await cryptoHelper.getWallet('wallet.0 ')

            assert.notStrictEqual(noSpace, withSpace)
        })
    })

    describe('IS-11: getNewAddress with addressIndex = 0', function () {

        it('derives a valid address at index 0', async function () {
            const result = await cryptoHelper.getNewAddress('test', 'bitcoin', 'regtest', null, 'legacy', 0)

            assert.ok(typeof result.address === 'string')
            assert.ok(result.address.length > 0)
            assert.ok(Buffer.isBuffer(result.privateKey))
            assert.ok(Buffer.isBuffer(result.publicKey))
        })
    })

    describe('IS-12: getNewAddress with large addressIndex', function () {

        it('derives a valid address at index 999', async function () {
            const result = await cryptoHelper.getNewAddress('test-large', 'bitcoin', 'regtest', null, 'legacy', 999)

            assert.ok(typeof result.address === 'string')
            assert.ok(result.address.length > 0)
        })

        it('derives different addresses at index 0 vs index 999', async function () {
            const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
            const r0 = await cryptoHelper.getNewAddress('idx0', 'bitcoin', 'regtest', mnemonic, 'legacy', 0)
            const r999 = await cryptoHelper.getNewAddress('idx999', 'bitcoin', 'regtest', mnemonic, 'legacy', 999)

            assert.notStrictEqual(r0.address, r999.address, 'different indices should produce different addresses')
        })
    })

    describe('IS-13: Same mnemonic + same index = same address', function () {

        it('produces deterministic addresses', async function () {
            const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
            const r1 = await cryptoHelper.getNewAddress('det1', 'bitcoin', 'regtest', mnemonic, 'legacy', 0)
            const r2 = await cryptoHelper.getNewAddress('det2', 'bitcoin', 'regtest', mnemonic, 'legacy', 0)

            assert.strictEqual(r1.address, r2.address, 'same mnemonic + index should produce same address')
        })
    })

    describe('IS-14: Multiple addresses accumulate in wallet', function () {

        it('appends each new address to the same wallet', async function () {
            await cryptoHelper.getNewAddress('multi', 'bitcoin', 'regtest', null, 'legacy', 0)
            await cryptoHelper.getNewAddress('multi', 'bitcoin', 'regtest', null, 'legacy', 1)
            await cryptoHelper.getNewAddress('multi', 'bitcoin', 'regtest', null, 'legacy', 2)

            const wallet = global.wallets['multi']
            assert.strictEqual(wallet.addresses.length, 3)

            const addrs = wallet.addresses.map(a => a.address)
            const unique = new Set(addrs)
            assert.strictEqual(unique.size, 3, 'all 3 addresses should be unique')
        })
    })

    describe('IS-15: Address format varies by network', function () {

        it('produces different addresses for bitcoin-regtest vs dogecoin-mainnet', async function () {
            const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
            // bitcoin-regtest pubKeyHash = 0x6f, dogecoin-mainnet pubKeyHash = 0x1e
            // These have different prefix bytes so addresses must differ
            const btc = await cryptoHelper.getNewAddress('btc-net', 'bitcoin', 'regtest', mnemonic, 'legacy', 0)
            const doge = await cryptoHelper.getNewAddress('doge-net', 'dogecoin', 'mainnet', mnemonic, 'legacy', 0)

            assert.notStrictEqual(btc.address, doge.address,
                'different pubKeyHash networks should produce different addresses')
        })

        it('bitcoin-regtest and litecoin-regtest share pubKeyHash 0x6f (same address)', async function () {
            const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
            const btc = await cryptoHelper.getNewAddress('btc-same', 'bitcoin', 'regtest', mnemonic, 'legacy', 0)
            const ltc = await cryptoHelper.getNewAddress('ltc-same', 'litecoin', 'regtest', mnemonic, 'legacy', 0)

            // Both use pubKeyHash 0x6f, so same key + same prefix = same address
            assert.strictEqual(btc.address, ltc.address,
                'networks with same pubKeyHash produce identical addresses from same key')
        })
    })
})
