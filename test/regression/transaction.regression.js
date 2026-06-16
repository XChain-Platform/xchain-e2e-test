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

const assert  = require('assert')
const sinon   = require('sinon')
const bitcoin = require('bitcoinjs-lib')

const transactionHelper = require('../transactionHelper')

// ── Helpers ──────────────────────────────────────────────────────────────

function resetGlobals() {
    global.NETWORK_OBJECT       = { ...bitcoin.networks.regtest, dustThreshold: 546 }
    global.encoderConnector     = { createTx: async () => {} }
    global.nodeConnector        = {
        broadcastTx:       async () => 'txhash-stub',
        waitForTx:         async () => true,
        getFeePerKilobyte: async () => 0.001,
        getTransactionHex: async () => ''
    }
    global.utxoTrackerConnector = {
        getUtxosFromAddress: async () => ({ utxos: [] }),
        waitForUtxos:        async () => true
    }
}

function buildMinimalPsbt(privKeyBuf) {
    const ecc    = require('tiny-secp256k1')
    const { ECPairFactory } = require('ecpair')
    const ECPair = ECPairFactory(ecc)
    const network = global.NETWORK_OBJECT
    const keyPair = ECPair.fromPrivateKey(privKeyBuf, { network })
    const p2wpkh  = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network })

    const psbt = new bitcoin.Psbt({ network })
    psbt.addInput({
        hash: 'a'.repeat(64),
        index: 0,
        witnessUtxo: { script: p2wpkh.output, value: 100000 }
    })
    psbt.addOutput({ address: p2wpkh.address, value: 90000 })
    return { psbt: psbt.toHex(), encoding: 'OP_RETURN' }
}

function stubDateNowExpired() {
    let callCount = 0
    const BASE = 1_000_000
    return sinon.stub(Date, 'now').callsFake(() => {
        callCount++
        return callCount === 1 ? BASE : BASE + 999_999_999
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// P0 — Transaction Pipeline Regression Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('[regression:p0] Transaction Pipeline', function () {

    beforeEach(function () {
        resetGlobals()
    })

    afterEach(function () {
        sinon.restore()
    })

    // ── isSegwitUTXO ─────────────────────────────────────────────────────

    describe('isSegwitUTXO', function () {

        it('[regression:p0] R-TX-006a — returns true for P2WPKH scriptPubKey', function () {
            const hash = 'a'.repeat(40)
            assert.strictEqual(transactionHelper.isSegwitUTXO({ scriptPubKey: '0014' + hash }), true)
        })

        it('[regression:p0] R-TX-006b — returns true for P2WSH scriptPubKey', function () {
            const hash = 'b'.repeat(64)
            assert.strictEqual(transactionHelper.isSegwitUTXO({ scriptPubKey: '0020' + hash }), true)
        })

        it('[regression:p0] R-TX-006c — returns false for P2PKH scriptPubKey', function () {
            assert.strictEqual(
                transactionHelper.isSegwitUTXO({ scriptPubKey: '76a914' + 'a'.repeat(40) + '88ac' }),
                false
            )
        })

        it('[regression:p0] R-TX-006d — returns false for P2SH scriptPubKey', function () {
            assert.strictEqual(
                transactionHelper.isSegwitUTXO({ scriptPubKey: 'a914' + 'c'.repeat(40) + '87' }),
                false
            )
        })

        it('[regression:p0] R-TX-006e — returns false for empty scriptPubKey', function () {
            assert.strictEqual(transactionHelper.isSegwitUTXO({ scriptPubKey: '' }), false)
        })

        it('[regression:p0] R-TX-006f — returns false for null scriptPubKey (no crash)', function () {
            assert.strictEqual(transactionHelper.isSegwitUTXO({ scriptPubKey: null }), false)
        })
    })

    // ── createAndSendTransaction ─────────────────────────────────────────

    describe('createAndSendTransaction', function () {

        it('[regression:p0] R-TX-001 — calls encoderConnector.createTx with correct arguments', async function () {
            const ecc    = require('tiny-secp256k1')
            const { ECPairFactory } = require('ecpair')
            const ECPair = ECPairFactory(ecc)

            const privKey = Buffer.alloc(32, 0x01)
            const keyPair = ECPair.fromPrivateKey(privKey, { network: global.NETWORK_OBJECT })
            const { address } = bitcoin.payments.p2wpkh({
                pubkey: keyPair.publicKey, network: global.NETWORK_OBJECT
            })

            const createTxStub = sinon.stub(global.encoderConnector, 'createTx')
                .resolves(buildMinimalPsbt(privKey))
            sinon.stub(global.nodeConnector, 'broadcastTx').resolves('txhash-001')
            sinon.stub(global.nodeConnector, 'waitForTx').resolves(true)
            sinon.stub(global.utxoTrackerConnector, 'getUtxosFromAddress').resolves({ utxos: [] })
            const dateStub = stubDateNowExpired()

            try {
                await transactionHelper.createAndSendTransaction(
                    { address, privateKey: privKey, publicKey: keyPair.publicKey },
                    { action: 'ISSUE' }
                )
            } finally {
                dateStub.restore()
            }

            assert.ok(createTxStub.calledOnce, 'createTx should be called once')
            const args = createTxStub.firstCall.args
            assert.strictEqual(args[1], address, 'pubkey arg')
            assert.deepStrictEqual(args[3], { action: 'ISSUE' }, 'data arg')
            assert.strictEqual(args[8], address, 'changeAddress arg')
        })

        it('[regression:p0] R-TX-002 — broadcasts transaction after signing', async function () {
            const ecc    = require('tiny-secp256k1')
            const { ECPairFactory } = require('ecpair')
            const ECPair = ECPairFactory(ecc)

            const privKey = Buffer.alloc(32, 0x02)
            const keyPair = ECPair.fromPrivateKey(privKey, { network: global.NETWORK_OBJECT })
            const { address } = bitcoin.payments.p2wpkh({
                pubkey: keyPair.publicKey, network: global.NETWORK_OBJECT
            })

            sinon.stub(global.encoderConnector, 'createTx').resolves(buildMinimalPsbt(privKey))
            const broadcastStub = sinon.stub(global.nodeConnector, 'broadcastTx').resolves('txhash-002')
            sinon.stub(global.nodeConnector, 'waitForTx').resolves(true)
            sinon.stub(global.utxoTrackerConnector, 'getUtxosFromAddress').resolves({ utxos: [] })
            const dateStub = stubDateNowExpired()

            try {
                await transactionHelper.createAndSendTransaction(
                    { address, privateKey: privKey, publicKey: keyPair.publicKey },
                    {}
                )
            } finally {
                dateStub.restore()
            }

            assert.ok(broadcastStub.calledOnce, 'broadcastTx should be called')
            assert.ok(typeof broadcastStub.firstCall.args[0] === 'string', 'should pass hex string')
        })
    })

    // ── createSimpleTransaction ──────────────────────────────────────────

    describe('createSimpleTransaction', function () {

        it('[regression:p0] R-TX-007 — function exists and is callable', function () {
            assert.strictEqual(typeof transactionHelper.createSimpleTransaction, 'function')
        })
    })

    // ── R-TX-008 — boundary: no UTXOs ────────────────────────────────────

    describe('boundary conditions', function () {

        it('[regression:p0] R-TX-008 — createSimpleTransaction throws when no UTXOs available', async function () {
            sinon.stub(global.utxoTrackerConnector, 'getUtxosFromAddress').resolves({ utxos: [] })
            sinon.stub(global.nodeConnector, 'getFeePerKilobyte').resolves(0.001)

            const privKey = Buffer.alloc(32, 0x03)
            const ecc    = require('tiny-secp256k1')
            const { ECPairFactory } = require('ecpair')
            const ECPair = ECPairFactory(ecc)
            const keyPair = ECPair.fromPrivateKey(privKey, { network: global.NETWORK_OBJECT })
            const { address } = bitcoin.payments.p2wpkh({
                pubkey: keyPair.publicKey, network: global.NETWORK_OBJECT
            })

            await assert.rejects(
                () => transactionHelper.createSimpleTransaction(
                    { address, privateKey: privKey, publicKey: keyPair.publicKey },
                    address,
                    10000
                ),
                /couldn't find any utxos/
            )
        })
    })
})
