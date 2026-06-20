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

// Integration tests for the full address funding flow:
// cryptoHelper.getNewFundedAddress → regtestMinerConnector → nodeConnector → utxoTrackerConnector

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')

const CryptoNetworks = require('../../../src/CryptoNetworks')

const cryptoHelper = require('../../../test/cryptoHelper')

describe('Funding Flow: cryptoHelper.getNewFundedAddress', function () {

    let savedGlobals

    beforeEach(function () {
        savedGlobals = {
            NETWORK_OBJECT: global.NETWORK_OBJECT,
            wallets: global.wallets,
            regtestMinerConnector: global.regtestMinerConnector,
            nodeConnector: global.nodeConnector,
            utxoTrackerConnector: global.utxoTrackerConnector,
        }

        global.NETWORK_OBJECT = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest')
        global.wallets = {}
    })

    afterEach(function () {
        Object.assign(global, savedGlobals)
        sinon.restore()
    })

    describe('Scenario 3.2.5: Full address funding flow', function () {

        it('generates address, funds it, waits for confirmation and UTXOs', async function () {
            const fundingTxId = 'funding' + '00'.repeat(28)
            let sendFundsCalled = null
            let waitForTxCalled = null
            let waitForUtxosCalled = null

            global.regtestMinerConnector = {
                sendFunds: async function (address, amount) {
                    sendFundsCalled = { address, amount }
                    return fundingTxId
                }
            }

            global.nodeConnector = {
                waitForTx: async function (txid) {
                    waitForTxCalled = txid
                    return true
                }
            }

            global.utxoTrackerConnector = {
                waitForUtxos: async function (address) {
                    waitForUtxosCalled = address
                    return true
                }
            }

            // seedGas=false: the faucet gas-mint rides the full encoder pipeline,
            // which these connector stubs don't model; it's covered by the live e2e
            // suites (every action test funds through it).
            const result = await cryptoHelper.getNewFundedAddress(
                'FUNDING.TEST', 'bitcoin', 'regtest', null, 'legacy', 0, 1, false
            )

            assert(result.mnemonic, 'should have a mnemonic')
            assert(result.privateKey, 'should have a private key')
            assert(result.publicKey, 'should have a public key')
            assert(result.address, 'should have an address')
            assert(typeof result.address === 'string', 'address is a string')

            assert(sendFundsCalled, 'regtestMinerConnector.sendFunds should have been called')
            assert.strictEqual(sendFundsCalled.address, result.address)
            assert.strictEqual(sendFundsCalled.amount, 1)

            assert.strictEqual(waitForTxCalled, fundingTxId)

            assert.strictEqual(waitForUtxosCalled, result.address)

            assert(global.wallets['FUNDING.TEST'], 'wallet should be cached')
            assert.strictEqual(global.wallets['FUNDING.TEST'].mnemonic, result.mnemonic)
        })

        it('throws when waitForTx returns false', async function () {
            global.regtestMinerConnector = {
                sendFunds: async () => 'sometxid'
            }
            global.nodeConnector = {
                waitForTx: async () => false
            }
            global.utxoTrackerConnector = {
                waitForUtxos: async () => true
            }

            await assert.rejects(
                () => cryptoHelper.getNewFundedAddress('FAIL.TEST', 'bitcoin', 'regtest', null, 'legacy', 0, 1),
                { message: "The sent tx didn't appear in the blockchain" }
            )
        })

        it('throws when waitForUtxos returns false', async function () {
            global.regtestMinerConnector = {
                sendFunds: async () => 'sometxid',
                generateBlocks: async () => []
            }
            global.nodeConnector = {
                waitForTx: async () => true
            }
            global.utxoTrackerConnector = {
                waitForUtxos: async () => false,
                getSyncStatus: async () => null
            }

            await assert.rejects(
                () => cryptoHelper.getNewFundedAddress('FAIL.TEST2', 'bitcoin', 'regtest', null, 'legacy', 0, 1, false),
                // Message carries a tracker/node sync-state suffix for stall diagnosis.
                { message: /The utxo tracker couldn't parse the utxo/ }
            )
        })
    })

    describe('Scenario: Wallet cache persistence across calls', function () {

        it('second getNewAddress for same label reuses existing mnemonic', async function () {
            const addr1 = await cryptoHelper.getNewAddress('CACHE.TEST', 'bitcoin', 'regtest', null, 'legacy', 0)
            const addr2 = await cryptoHelper.getNewAddress('CACHE.TEST', 'bitcoin', 'regtest', null, 'legacy', 1)

            const wallet = global.wallets['CACHE.TEST']
            assert.strictEqual(wallet.mnemonic, addr1.mnemonic, 'wallet stores first mnemonic')
            assert.notStrictEqual(addr1.address, addr2.address, 'different addresses for different indices')
            assert.strictEqual(wallet.addresses.length, 2, 'wallet has 2 addresses')
        })

        it('different labels produce independent wallets', async function () {
            const addr1 = await cryptoHelper.getNewAddress('WALLET.A', 'bitcoin', 'regtest')
            const addr2 = await cryptoHelper.getNewAddress('WALLET.B', 'bitcoin', 'regtest')

            assert.notStrictEqual(addr1.mnemonic, addr2.mnemonic, 'different mnemonics')
            assert.notStrictEqual(addr1.address, addr2.address, 'different addresses')
        })
    })
})
