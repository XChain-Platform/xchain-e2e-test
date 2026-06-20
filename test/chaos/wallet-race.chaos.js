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

// Chaos Experiment 11: Concurrent Wallet Access (@P2)
//
// Verifies that concurrent getNewAddress calls for the same label
// do not overwrite each other's address entries, and that different
// labels remain fully isolated.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const { saveGlobals, restoreGlobals } = require('./chaos-helpers')

describe('Chaos Experiment 11: Concurrent Wallet Access @P2', function () {

    let savedWallets, savedNetwork, savedCoin, savedNetworkObj
    let cryptoHelper

    beforeEach(function () {
        savedWallets = global.wallets
        savedNetwork = global.NETWORK
        savedCoin = global.COIN
        savedNetworkObj = global.NETWORK_OBJECT

        global.NETWORK = 'regtest'
        global.COIN = 'bitcoin'
        global.NETWORK_OBJECT = bitcoin.networks.regtest
        global.wallets = {}

        // Fresh require to reset module state
        delete require.cache[require.resolve('../cryptoHelper')]
        cryptoHelper = require('../cryptoHelper')
    })

    afterEach(function () {
        global.wallets = savedWallets
        global.NETWORK = savedNetwork
        global.COIN = savedCoin
        global.NETWORK_OBJECT = savedNetworkObj
        sinon.restore()
    })

    describe('concurrent getNewAddress for same label', function () {

        it('all addresses are preserved when called concurrently', async function () {
            const promises = []
            for (let i = 0; i < 5; i++) {
                promises.push(cryptoHelper.getNewAddress('CHAOS.CONCURRENT', 'bitcoin', 'regtest', null, 'legacy', i))
            }

            const results = await Promise.all(promises)

            // All 5 calls should produce valid results
            assert.strictEqual(results.length, 5)
            results.forEach(r => {
                assert.ok(r.address, 'each result should have an address')
                assert.ok(r.privateKey, 'each result should have a privateKey')
            })

            // All addresses should be in the wallet
            const wallet = global.wallets['CHAOS.CONCURRENT']
            assert.ok(wallet, 'wallet should exist')
            assert.strictEqual(wallet.addresses.length, 5, 'all 5 addresses should be stored')
        })

        it('all addresses are unique', async function () {
            const promises = []
            for (let i = 0; i < 5; i++) {
                promises.push(cryptoHelper.getNewAddress('CHAOS.UNIQUE', 'bitcoin', 'regtest', null, 'legacy', i))
            }

            const results = await Promise.all(promises)

            const addresses = results.map(r => r.address)
            const uniqueAddresses = new Set(addresses)
            assert.strictEqual(uniqueAddresses.size, 5, 'all addresses should be unique')
        })

        it('mnemonic is consistent across concurrent calls', async function () {
            const promises = []
            for (let i = 0; i < 3; i++) {
                promises.push(cryptoHelper.getNewAddress('CHAOS.MNEMONIC', 'bitcoin', 'regtest', null, 'legacy', i))
            }

            const results = await Promise.all(promises)

            // Every call now reports wallet.mnemonic; guard against nulls anyway.
            const mnemonics = results.map(r => r.mnemonic).filter(m => m !== null)
            assert(mnemonics.length >= 1, 'at least one result should have a mnemonic')

            // All non-null mnemonics should be the same
            const uniqueMnemonics = new Set(mnemonics)
            assert.strictEqual(uniqueMnemonics.size, 1, 'all mnemonics should be identical')
        })
    })

    describe('different labels are fully isolated', function () {

        it('concurrent calls for different labels create separate wallets', async function () {
            const promises = [
                cryptoHelper.getNewAddress('CHAOS.LABEL_A', 'bitcoin', 'regtest', null, 'legacy', 0),
                cryptoHelper.getNewAddress('CHAOS.LABEL_B', 'bitcoin', 'regtest', null, 'legacy', 0),
                cryptoHelper.getNewAddress('CHAOS.LABEL_C', 'bitcoin', 'regtest', null, 'legacy', 0),
            ]

            await Promise.all(promises)

            assert.ok(global.wallets['CHAOS.LABEL_A'], 'label A wallet should exist')
            assert.ok(global.wallets['CHAOS.LABEL_B'], 'label B wallet should exist')
            assert.ok(global.wallets['CHAOS.LABEL_C'], 'label C wallet should exist')

            // Each wallet should have exactly 1 address
            assert.strictEqual(global.wallets['CHAOS.LABEL_A'].addresses.length, 1)
            assert.strictEqual(global.wallets['CHAOS.LABEL_B'].addresses.length, 1)
            assert.strictEqual(global.wallets['CHAOS.LABEL_C'].addresses.length, 1)

            const mnemonicA = global.wallets['CHAOS.LABEL_A'].mnemonic
            const mnemonicB = global.wallets['CHAOS.LABEL_B'].mnemonic
            assert.notStrictEqual(mnemonicA, mnemonicB, 'different labels should have different mnemonics')
        })

        it('adding address to label A does not affect label B', async function () {
            await cryptoHelper.getNewAddress('CHAOS.ISOLATED_A', 'bitcoin', 'regtest', null, 'legacy', 0)
            await cryptoHelper.getNewAddress('CHAOS.ISOLATED_B', 'bitcoin', 'regtest', null, 'legacy', 0)
            await cryptoHelper.getNewAddress('CHAOS.ISOLATED_A', 'bitcoin', 'regtest', null, 'legacy', 1)

            assert.strictEqual(global.wallets['CHAOS.ISOLATED_A'].addresses.length, 2)
            assert.strictEqual(global.wallets['CHAOS.ISOLATED_B'].addresses.length, 1)
        })
    })

    describe('wallet state after failure', function () {

        it('wallet is created in cache even when subsequent operations might fail', async function () {
            // Just verify the wallet is created on getNewAddress, regardless of funding
            await cryptoHelper.getNewAddress('CHAOS.PREFAIL', 'bitcoin', 'regtest', null, 'legacy', 0)

            assert.ok('CHAOS.PREFAIL' in global.wallets)
            assert.strictEqual(global.wallets['CHAOS.PREFAIL'].addresses.length, 1)
            assert.ok(global.wallets['CHAOS.PREFAIL'].mnemonic)
            assert.ok(Buffer.isBuffer(global.wallets['CHAOS.PREFAIL'].seed))
        })

        it('subsequent getNewAddress with same label reuses existing wallet', async function () {
            const addr1 = await cryptoHelper.getNewAddress('CHAOS.REUSE', 'bitcoin', 'regtest', null, 'legacy', 0)
            const addr2 = await cryptoHelper.getNewAddress('CHAOS.REUSE', 'bitcoin', 'regtest', null, 'legacy', 1)

            assert.strictEqual(global.wallets['CHAOS.REUSE'].addresses.length, 2)
            // First call generates and returns the mnemonic
            assert.ok(addr1.mnemonic, 'first call should return mnemonic')
            // getNewAddress returns wallet.mnemonic, so subsequent calls for the
            // same label report the same mnemonic the wallet was initialized with.
            assert.strictEqual(addr2.mnemonic, addr1.mnemonic, 'second call returns the wallet mnemonic')
            // But the wallet itself retains the mnemonic
            assert.strictEqual(global.wallets['CHAOS.REUSE'].mnemonic, addr1.mnemonic)
            // Different addresses (different index)
            assert.notStrictEqual(addr1.address, addr2.address)
        })
    })
})
