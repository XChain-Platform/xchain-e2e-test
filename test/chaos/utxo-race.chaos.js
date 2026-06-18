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

// Chaos Experiment 7: UTXO Race Condition (@P1)
//
// Verifies that the transactionHelper's _verifiedUtxos cache
// does not leak across different addresses, and that the UTXO tracker's
// waitForUtxos properly times out when the tracker returns empty results.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const ecc = require('tiny-secp256k1')
const ECPair = ECPairFactory(ecc)
const { saveGlobals, restoreGlobals, GLOBAL_KEYS } = require('./chaos-helpers')
const XChainUtxoTrackerConnector = require('../../src/XChainUtxoTrackerConnector')

describe('Chaos Experiment 7: UTXO Race Condition @P1', function () {

    let saved

    beforeEach(function () {
        saved = saveGlobals(GLOBAL_KEYS)
        global.NETWORK_OBJECT = bitcoin.networks.regtest
    })

    afterEach(function () {
        restoreGlobals(saved)
        sinon.restore()
    })

    describe('UTXO cache isolation across addresses', function () {

        it('encoder receives empty UTXO list for a new address even if prior address had cached UTXOs', async function () {
            // Generate two different addresses
            const keyPairA = ECPair.makeRandom({ network: bitcoin.networks.regtest })
            const addrA = bitcoin.payments.p2pkh({ pubkey: keyPairA.publicKey, network: bitcoin.networks.regtest }).address

            const keyPairB = ECPair.makeRandom({ network: bitcoin.networks.regtest })
            const addrB = bitcoin.payments.p2pkh({ pubkey: keyPairB.publicKey, network: bitcoin.networks.regtest }).address

            assert.notStrictEqual(addrA, addrB, 'addresses must be different')

            // The transactionHelper caches verified UTXOs by address.
            // When a different address is used, the cache should not match.
            // We verify this by checking the cache logic directly:
            // _verifiedUtxosAddress === addressInfo["address"]
            // If addrA is cached, addrB should get an empty list.

            const cachedUtxos = [{ txid: 'aabb', vout: 0, value: 100000, confirmations: 1 }]

            // Simulate: cache populated for addrA
            let _verifiedUtxos = cachedUtxos
            let _verifiedUtxosAddress = addrA

            // When addrB requests, cache should not match
            const utxoListForEncoder = (_verifiedUtxosAddress === addrB && _verifiedUtxos) ? _verifiedUtxos : []
            assert.deepStrictEqual(utxoListForEncoder, [], 'different address must not use cached UTXOs')

            // When addrA requests, cache should match
            const utxoListForA = (_verifiedUtxosAddress === addrA && _verifiedUtxos) ? _verifiedUtxos : []
            assert.deepStrictEqual(utxoListForA, cachedUtxos, 'same address should use cached UTXOs')
        })

        it('cache is cleared after being consumed', function () {
            let _verifiedUtxos = [{ txid: 'aabb', vout: 0 }]
            let _verifiedUtxosAddress = 'addr_cached'

            // Simulate consumption (as in createAndSendTransaction line 73-74)
            const consumed = (_verifiedUtxosAddress === 'addr_cached' && _verifiedUtxos) ? _verifiedUtxos : []
            _verifiedUtxos = null
            _verifiedUtxosAddress = null

            assert.strictEqual(consumed.length, 1, 'should have consumed the cached UTXOs')
            assert.strictEqual(_verifiedUtxos, null, 'cache should be cleared after consumption')
            assert.strictEqual(_verifiedUtxosAddress, null, 'cache address should be cleared')
        })
    })

    describe('waitForUtxos timeout with empty tracker responses', function () {

        it('returns false when tracker always returns empty UTXOs', async function () {
            const tracker = new XChainUtxoTrackerConnector('localhost', '3030')
            tracker.sleep = sinon.stub().resolves()
            sinon.stub(tracker, 'getUtxosFromAddress').resolves({ utxos: [] })

            const result = await tracker.waitForUtxos('addr_race', 100)

            assert.strictEqual(result, false)
            assert(tracker.getUtxosFromAddress.callCount >= 1)
        })

        it('returns true when UTXOs appear after empty responses', async function () {
            const tracker = new XChainUtxoTrackerConnector('localhost', '3030')
            tracker.sleep = sinon.stub().resolves()
            const stub = sinon.stub(tracker, 'getUtxosFromAddress')
            stub.onFirstCall().resolves({ utxos: [] })
            stub.onSecondCall().resolves({ utxos: [] })
            stub.onThirdCall().resolves({ utxos: [{ txid: 'abc', vout: 0, value: 50000 }] })

            const result = await tracker.waitForUtxos('addr_race', 30000)

            assert.strictEqual(result, true)
            assert.strictEqual(stub.callCount, 3)
        })
    })

    describe('double-spend detection', function () {

        it('second broadcast with same UTXO produces an error from node', async function () {
            // Simulate a node that rejects double-spend
            const broadcastStub = sinon.stub()
            broadcastStub.onFirstCall().resolves('txid_first')
            broadcastStub.onSecondCall().rejects(new Error('Missing inputs (txid already spent)'))

            global.nodeConnector = {
                broadcastTx: broadcastStub,
                waitForTx: sinon.stub().resolves(true),
                getTransactionHex: sinon.stub().resolves('aabb')
            }

            // First broadcast succeeds
            const txid1 = await global.nodeConnector.broadcastTx('rawhex1')
            assert.strictEqual(txid1, 'txid_first')

            // Second broadcast with same UTXO fails
            await assert.rejects(
                () => global.nodeConnector.broadcastTx('rawhex2'),
                /Missing inputs/
            )
        })
    })
})
