'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Integration tests for wallet cache persistence and isolation.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const CryptoNetworks = require('../../../src/CryptoNetworks')

describe('State Management — Wallet Cache', function () {

    let cryptoHelper
    let savedGlobals

    beforeEach(function () {
        savedGlobals = {
            wallets: global.wallets,
            NETWORK_OBJECT: global.NETWORK_OBJECT,
            regtestMinerConnector: global.regtestMinerConnector,
            nodeConnector: global.nodeConnector,
            utxoTrackerConnector: global.utxoTrackerConnector,
        }

        // Fresh wallets state for each test
        global.wallets = {}
        global.NETWORK_OBJECT = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest')

        // Clear module cache for a clean cryptoHelper
        delete require.cache[require.resolve('../../../test/cryptoHelper')]
        cryptoHelper = require('../../../test/cryptoHelper')
        // cryptoHelper sets global.wallets = {} on load, but we already did that
    })

    afterEach(function () {
        Object.assign(global, savedGlobals)
        sinon.restore()
    })

    describe('Scenario 3.6.1: Wallet cache persistence across test cases', function () {

        it('wallet created in first test is accessible in second test', async function () {
            // Simulate "Test A" creating a wallet
            const addr1 = await cryptoHelper.getNewAddress('ISSUE.V0', 'bitcoin', 'regtest')

            // Simulate "Test B" accessing the same wallet
            const wallet = await cryptoHelper.getWallet('ISSUE.V0')

            assert.strictEqual(wallet.mnemonic, addr1.mnemonic, 'same mnemonic')
            assert.strictEqual(wallet.addresses.length, 1)
            assert.strictEqual(wallet.addresses[0].address, addr1.address)
        })

        it('second address for same label appends to wallet', async function () {
            await cryptoHelper.getNewAddress('MULTI.ADDR', 'bitcoin', 'regtest', null, 'legacy', 0)
            await cryptoHelper.getNewAddress('MULTI.ADDR', 'bitcoin', 'regtest', null, 'legacy', 1)

            const wallet = await cryptoHelper.getWallet('MULTI.ADDR')
            assert.strictEqual(wallet.addresses.length, 2, 'two addresses in wallet')
            assert.notStrictEqual(
                wallet.addresses[0].address,
                wallet.addresses[1].address,
                'addresses are different'
            )
        })
    })

    describe('Scenario 3.6.2: Different labels are isolated', function () {

        it('labels produce independent wallets with different mnemonics', async function () {
            const addr1 = await cryptoHelper.getNewAddress('WALLET.A', 'bitcoin', 'regtest')
            const addr2 = await cryptoHelper.getNewAddress('WALLET.B', 'bitcoin', 'regtest')

            assert.notStrictEqual(addr1.mnemonic, addr2.mnemonic, 'different mnemonics')
            assert.notStrictEqual(addr1.address, addr2.address, 'different addresses')

            assert(global.wallets['WALLET.A'], 'WALLET.A exists')
            assert(global.wallets['WALLET.B'], 'WALLET.B exists')
            assert.notStrictEqual(
                global.wallets['WALLET.A'].mnemonic,
                global.wallets['WALLET.B'].mnemonic
            )
        })
    })

    describe('Scenario: Explicit mnemonic is reused', function () {

        it('passing a mnemonic to getNewAddress uses it instead of generating', async function () {
            const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

            const addr1 = await cryptoHelper.getNewAddress('EXPLICIT', 'bitcoin', 'regtest', testMnemonic)

            assert.strictEqual(addr1.mnemonic, testMnemonic)

            // Second call without mnemonic reuses the wallet's stored mnemonic,
            // and getNewAddress now reports that stored mnemonic back in the result.
            const addr2 = await cryptoHelper.getNewAddress('EXPLICIT', 'bitcoin', 'regtest', null, 'legacy', 1)
            const wallet = await cryptoHelper.getWallet('EXPLICIT')

            assert.strictEqual(wallet.mnemonic, testMnemonic, 'wallet stores original mnemonic')
            assert.notStrictEqual(addr1.address, addr2.address, 'different derivation indices produce different addresses')
        })
    })
})
