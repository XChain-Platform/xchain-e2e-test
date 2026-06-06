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

// Integration tests for the standard OP_RETURN transaction pipeline.
//
// Tests the real integration between transactionHelper → encoderConnector → nodeConnector
// → utxoTrackerConnector, with HTTP calls stubbed at the network boundary.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const ecc = require('tiny-secp256k1')
const ECPair = ECPairFactory(ecc)

const transactionHelper = require('../../../test/transactionHelper')
const fixtures = require('../fixtures/services')

describe('Transaction Pipeline — standard OP_RETURN flow', function () {

    let savedGlobals
    let testKeyPair
    let testAddress
    let addressInfo

    before(function () {
        // Generate a real key pair for PSBT signing
        testKeyPair = ECPair.makeRandom({ network: bitcoin.networks.regtest })
        const { address } = bitcoin.payments.p2pkh({
            pubkey: testKeyPair.publicKey,
            network: bitcoin.networks.regtest
        })
        testAddress = address
        addressInfo = {
            address: testAddress,
            privateKey: testKeyPair.privateKey,
            publicKey: testKeyPair.publicKey
        }
    })

    beforeEach(function () {
        savedGlobals = {
            NETWORK_OBJECT: global.NETWORK_OBJECT,
            encoderConnector: global.encoderConnector,
            nodeConnector: global.nodeConnector,
            utxoTrackerConnector: global.utxoTrackerConnector,
        }
        global.NETWORK_OBJECT = { ...bitcoin.networks.regtest, dustThreshold: 546 }
    })

    afterEach(function () {
        Object.assign(global, savedGlobals)
        sinon.restore()
    })

    // Build a real PSBT that can actually be signed by testKeyPair
    function buildMockPsbt() {
        const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest })

        // Create a funding transaction (the "previous tx")
        const fundingTx = new bitcoin.Transaction()
        fundingTx.version = 2
        fundingTx.addInput(Buffer.alloc(32, 0), 0)
        fundingTx.addOutput(
            bitcoin.payments.p2pkh({
                pubkey: testKeyPair.publicKey,
                network: bitcoin.networks.regtest
            }).output,
            100000
        )

        psbt.addInput({
            hash: fundingTx.getHash(),
            index: 0,
            nonWitnessUtxo: fundingTx.toBuffer(),
        })

        // OP_RETURN output with XChain data
        const data = Buffer.from('ISSUE|0|TEST', 'utf8')
        const opReturnScript = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, data])
        psbt.addOutput({ script: opReturnScript, value: 0 })

        // Change output
        psbt.addOutput({ address: testAddress, value: 90000 })

        return psbt.toHex()
    }

    describe('Scenario 3.2.1: Standard OP_RETURN transaction', function () {

        it('sends message through encoder → sign → broadcast pipeline', async function () {
            const mockPsbtHex = buildMockPsbt()
            const expectedTxId = 'aabb' + 'cc'.repeat(30)

            let encoderCallArgs = null
            global.encoderConnector = {
                createTx: async function (...args) {
                    encoderCallArgs = args
                    return { encoding: 'opreturn', psbt: mockPsbtHex }
                }
            }

            let broadcastCallHex = null
            global.nodeConnector = {
                broadcastTx: async function (hex) {
                    broadcastCallHex = hex
                    return expectedTxId
                },
                waitForTx: async () => true,
            }

            global.utxoTrackerConnector = {
                getUtxosFromAddress: async () => ({
                    utxos: [{ txid: expectedTxId, vout: 1, value: 90000, confirmations: 1 }]
                })
            }

            const txHash = await transactionHelper.createAndSendTransaction(
                addressInfo, 'ISSUE|0|TEST|1000|100|8|desc|50'
            )

            // Encoder received the correct arguments
            assert(encoderCallArgs, 'encoderConnector.createTx should have been called')
            assert.strictEqual(encoderCallArgs[1], testAddress, 'encoder received correct address')
            assert.strictEqual(encoderCallArgs[3], 'ISSUE|0|TEST|1000|100|8|desc|50', 'encoder received correct data')

            // Broadcast received a signed transaction hex
            assert(broadcastCallHex, 'nodeConnector.broadcastTx should have been called')
            assert(typeof broadcastCallHex === 'string', 'broadcast received hex string')
            assert(broadcastCallHex.length > 0, 'broadcast hex is non-empty')

            // Returns the broadcast txid
            assert.strictEqual(txHash, expectedTxId)
        })

        it('passes empty utxo list to encoder on first call (no cache)', async function () {
            // Use a fresh address to avoid picking up cached UTXOs from prior tests
            const freshKeyPair = ECPair.makeRandom({ network: bitcoin.networks.regtest })
            const { address: freshAddress } = bitcoin.payments.p2pkh({
                pubkey: freshKeyPair.publicKey,
                network: bitcoin.networks.regtest
            })
            const freshAddrInfo = {
                address: freshAddress,
                privateKey: freshKeyPair.privateKey,
                publicKey: freshKeyPair.publicKey
            }

            // Build a PSBT matching the fresh key
            const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest })
            const fundTx = new bitcoin.Transaction()
            fundTx.version = 2
            fundTx.addInput(Buffer.alloc(32, 0), 0)
            fundTx.addOutput(
                bitcoin.payments.p2pkh({ pubkey: freshKeyPair.publicKey, network: bitcoin.networks.regtest }).output,
                100000
            )
            psbt.addInput({ hash: fundTx.getHash(), index: 0, nonWitnessUtxo: fundTx.toBuffer() })
            const data = Buffer.from('ISSUE|0|TEST', 'utf8')
            psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, data]), value: 0 })
            psbt.addOutput({ address: freshAddress, value: 90000 })
            const freshPsbtHex = psbt.toHex()

            const broadcastTxId = 'txid1' + '00'.repeat(28)

            let encoderUtxoArg = null
            global.encoderConnector = {
                createTx: async function (utxos) {
                    encoderUtxoArg = utxos
                    return { encoding: 'opreturn', psbt: freshPsbtHex }
                }
            }
            global.nodeConnector = {
                broadcastTx: async () => broadcastTxId,
                waitForTx: async () => true,
            }
            global.utxoTrackerConnector = {
                getUtxosFromAddress: async () => ({
                    utxos: [{ txid: broadcastTxId, vout: 1, value: 90000, confirmations: 1 }]
                })
            }

            await transactionHelper.createAndSendTransaction(freshAddrInfo, 'ISSUE|0|TEST')

            assert.deepStrictEqual(encoderUtxoArg, [], 'first call sends empty utxo list')
        })
    })

    describe('Scenario 3.2.3: UTXO cache reuse across sequential transactions', function () {

        it('passes cached UTXOs on second call for same address', async function () {
            const mockPsbtHex = buildMockPsbt()
            const txid1 = 'first' + '00'.repeat(29)

            const confirmedUtxos = [
                { txid: txid1, vout: 1, value: 90000, confirmations: 1, scriptPubKey: '76a914' + 'aa'.repeat(20) + '88ac' }
            ]

            let encoderCalls = []
            global.encoderConnector = {
                createTx: async function (utxos, ...rest) {
                    encoderCalls.push(utxos)
                    return { encoding: 'opreturn', psbt: mockPsbtHex }
                }
            }
            global.nodeConnector = {
                broadcastTx: async () => txid1,
                waitForTx: async () => true,
            }
            global.utxoTrackerConnector = {
                getUtxosFromAddress: async () => ({ utxos: confirmedUtxos })
            }

            // First call — should send empty utxos, then cache confirmed UTXOs
            await transactionHelper.createAndSendTransaction(addressInfo, 'ISSUE|0|TEST')

            // Second call — should use cached UTXOs
            await transactionHelper.createAndSendTransaction(addressInfo, 'SEND|0|TEST|100')

            assert.strictEqual(encoderCalls.length, 2)
            assert.deepStrictEqual(encoderCalls[0], [], 'first call: empty utxo list')
            assert.strictEqual(encoderCalls[1].length, 1, 'second call: cached utxos passed')
            assert.strictEqual(encoderCalls[1][0].txid, txid1, 'cached utxo has correct txid')
        })
    })

    describe('Scenario 3.2.4: UTXO cache isolation between addresses', function () {

        it('does not use address A cache for address B', async function () {
            const txid1 = 'aaaa' + '00'.repeat(30)

            // Create a second key pair and build PSBTs for each
            const keyPair2 = ECPair.makeRandom({ network: bitcoin.networks.regtest })
            const { address: address2 } = bitcoin.payments.p2pkh({
                pubkey: keyPair2.publicKey,
                network: bitcoin.networks.regtest
            })
            const addressInfo2 = {
                address: address2,
                privateKey: keyPair2.privateKey,
                publicKey: keyPair2.publicKey
            }

            // Build PSBTs that match each key for valid signing
            function buildPsbtFor(kp, addr) {
                const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest })
                const fundTx = new bitcoin.Transaction()
                fundTx.version = 2
                fundTx.addInput(Buffer.alloc(32, 0), 0)
                fundTx.addOutput(
                    bitcoin.payments.p2pkh({ pubkey: kp.publicKey, network: bitcoin.networks.regtest }).output,
                    100000
                )
                psbt.addInput({ hash: fundTx.getHash(), index: 0, nonWitnessUtxo: fundTx.toBuffer() })
                const data = Buffer.from('TEST', 'utf8')
                psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, data]), value: 0 })
                psbt.addOutput({ address: addr, value: 90000 })
                return psbt.toHex()
            }

            const psbt1Hex = buildPsbtFor(testKeyPair, testAddress)
            const psbt2Hex = buildPsbtFor(keyPair2, address2)

            let encoderCalls = []
            global.encoderConnector = {
                createTx: async function (utxos, pubkey) {
                    encoderCalls.push({ utxos, address: pubkey })
                    // Return the PSBT matching the requesting address's key
                    if (pubkey === testAddress) return { encoding: 'opreturn', psbt: psbt1Hex }
                    return { encoding: 'opreturn', psbt: psbt2Hex }
                }
            }
            global.nodeConnector = {
                broadcastTx: async () => txid1,
                waitForTx: async () => true,
            }
            global.utxoTrackerConnector = {
                getUtxosFromAddress: async () => ({
                    utxos: [{ txid: txid1, vout: 0, value: 50000, confirmations: 1 }]
                })
            }

            // Call with addressInfo (caches UTXOs for testAddress)
            await transactionHelper.createAndSendTransaction(addressInfo, 'ISSUE|0|TEST')

            // Call with addressInfo2 (different address — should NOT use cached UTXOs)
            await transactionHelper.createAndSendTransaction(addressInfo2, 'SEND|0|TEST|50')

            assert.strictEqual(encoderCalls.length, 2)
            assert.deepStrictEqual(encoderCalls[1].utxos, [], 'different address gets empty utxo list')
        })
    })
})
