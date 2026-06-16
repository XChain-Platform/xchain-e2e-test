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

// Fuzz tests for cryptoHelper: wallet label handling, coin/network combos,
// addressIndex, and mnemonic inputs.

const assert = require('assert')
const sinon = require('sinon')
const fc = require('fast-check')

const CryptoNetworks = require('../../src/CryptoNetworks')
const gen = require('./fuzz-generators')

// Set up globals before requiring cryptoHelper
global.wallets = {}
global.regtestMinerConnector = { sendFunds: async () => 'txid-stub' }
global.nodeConnector = { waitForTx: async () => true }
global.utxoTrackerConnector = { waitForUtxos: async () => true }

const cryptoHelper = require('../cryptoHelper')

const FC_PARAMS = { numRuns: 200 }

describe('Fuzz — CryptoHelper', function () {

    beforeEach(function () {
        global.wallets = {}
    })

    afterEach(function () {
        sinon.restore()
        global.wallets = {}
    })

    // ── getWallet with fuzzed labels ────────────────────────────

    describe('getWallet with fuzzed labels', function () {

        it('never crashes with any string label', async function () {
            await fc.assert(fc.asyncProperty(fc.string({ minLength: 0, maxLength: 1000 }), async (label) => {
                const wallet = await cryptoHelper.getWallet(label)
                assert(wallet !== null && wallet !== undefined, 'wallet must not be null')
                assert.ok(label in global.wallets, 'label must be in global cache')
            }), FC_PARAMS)
        })

        it('never crashes with fuzzed non-string labels', async function () {
            await fc.assert(fc.asyncProperty(gen.anyFuzzValue, async (label) => {
                try {
                    const wallet = await cryptoHelper.getWallet(label)
                    // JavaScript's `in` operator converts label to string for property lookup
                    assert(wallet !== null && wallet !== undefined)
                } catch (e) {
                    // Symbol labels will throw in `label in wallets` — this is expected
                    if (e instanceof TypeError && e.message.includes('Cannot convert a Symbol')) {
                        return
                    }
                    throw e
                }
            }), FC_PARAMS)
        })

        it('returns same cached wallet for repeated calls', async function () {
            await fc.assert(fc.asyncProperty(fc.string({ minLength: 0, maxLength: 100 }), async (label) => {
                const first = await cryptoHelper.getWallet(label)
                const second = await cryptoHelper.getWallet(label)
                assert.strictEqual(first, second, 'must return cached object')
            }), FC_PARAMS)
        })
    })

    // ── getNewAddress with fuzzed coin/network ──────────────────

    describe('getNewAddress with fuzzed coin/network combos', function () {

        const validCombos = [
            ['bitcoin', 'regtest'], ['bitcoin', 'testnet'], ['bitcoin', 'mainnet'],
            ['litecoin', 'regtest'], ['litecoin', 'testnet'], ['litecoin', 'mainnet'],
            ['dogecoin', 'regtest'], ['dogecoin', 'testnet'], ['dogecoin', 'mainnet'],
        ]

        it('succeeds for all valid coin+network combinations', async function () {
            await fc.assert(fc.asyncProperty(
                fc.constantFrom(...validCombos),
                fc.nat({ max: 100 }),
                async ([coin, network], idx) => {
                    const label = `fuzz-${coin}-${network}-${idx}`
                    const result = await cryptoHelper.getNewAddress(label, coin, network, null, 'legacy', 0)
                    assert(typeof result.address === 'string')
                    assert(result.address.length > 0)
                    assert(Buffer.isBuffer(result.privateKey))
                    assert(Buffer.isBuffer(result.publicKey))
                }
            ), { numRuns: 50 })
        })

        it('throws or returns undefined for invalid coin+network combos', async function () {
            await fc.assert(fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 20 }),
                fc.string({ minLength: 1, maxLength: 20 }),
                async (coin, network) => {
                    // Skip valid combinations
                    const networkObj = CryptoNetworks.getBitcoinJsNetwork(coin + '-' + network)
                    if (networkObj !== undefined) return

                    const label = `fuzz-invalid-${coin}-${network}`
                    try {
                        await cryptoHelper.getNewAddress(label, coin, network, null, 'legacy', 0)
                        // If it doesn't throw, that's a finding — but not a crash
                    } catch (e) {
                        // Expected: invalid network causes error in bip32 or payments
                        assert(e instanceof Error || e instanceof TypeError)
                    }
                }
            ), { numRuns: 50 })
        })
    })

    // ── getNewAddress with fuzzed addressIndex ──────────────────

    describe('getNewAddress with fuzzed addressIndex', function () {

        it('handles various integer indices without crashing', async function () {
            await fc.assert(fc.asyncProperty(fc.nat({ max: 10000 }), async (idx) => {
                const label = `fuzz-idx-${idx}`
                const result = await cryptoHelper.getNewAddress(label, 'bitcoin', 'regtest', null, 'legacy', idx)
                assert(typeof result.address === 'string')
                assert(result.address.length > 0)
            }), { numRuns: 50 })
        })

        it('handles negative or non-integer indices gracefully', async function () {
            await fc.assert(fc.asyncProperty(
                fc.oneof(
                    fc.constant(-1),
                    fc.constant(-100),
                    fc.constant(0.5),
                    fc.constant(NaN),
                    fc.constant(Infinity),
                    fc.double()
                ),
                async (idx) => {
                    const label = `fuzz-bad-idx-${String(idx)}`
                    try {
                        await cryptoHelper.getNewAddress(label, 'bitcoin', 'regtest', null, 'legacy', idx)
                    } catch (e) {
                        // BIP32 derivation may throw for invalid indices — expected
                        assert(e instanceof Error || e instanceof TypeError || e instanceof RangeError)
                    }
                }
            ), { numRuns: 30 })
        })
    })

    // ── getNewAddress with fuzzed mnemonic ──────────────────────

    describe('getNewAddress with fuzzed mnemonic', function () {

        it('handles random strings as mnemonics gracefully', async function () {
            await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 200 }), async (mnemonic) => {
                const label = `fuzz-mnemonic-${mnemonic.slice(0, 10)}`
                try {
                    await cryptoHelper.getNewAddress(label, 'bitcoin', 'regtest', mnemonic, 'legacy', 0)
                    // bip39.mnemonicToSeedSync works with any string (generates a seed)
                    // even invalid mnemonics produce a seed — this is by design
                } catch (e) {
                    assert(e instanceof Error || e instanceof TypeError)
                }
            }), { numRuns: 50 })
        })
    })

    // ── CryptoNetworks.getBitcoinJsNetwork with fuzzed names ────

    describe('CryptoNetworks.getBitcoinJsNetwork with fuzzed input', function () {

        it('never crashes — returns object or undefined', function () {
            fc.assert(fc.property(gen.anyFuzzValue, (networkName) => {
                try {
                    const result = CryptoNetworks.getBitcoinJsNetwork(networkName)
                    assert(result === undefined || typeof result === 'object')
                } catch (e) {
                    // Should never throw for any input
                    assert.fail(`getBitcoinJsNetwork threw for input ${JSON.stringify(networkName)}: ${e.message}`)
                }
            }), FC_PARAMS)
        })
    })

    describe('CryptoNetworks.getFirstBlock with fuzzed input', function () {

        it('never crashes — returns a number', function () {
            fc.assert(fc.property(gen.anyFuzzValue, (networkName) => {
                const result = CryptoNetworks.getFirstBlock(networkName)
                assert(typeof result === 'number', `should return number, got: ${typeof result}`)
            }), FC_PARAMS)
        })
    })
})
