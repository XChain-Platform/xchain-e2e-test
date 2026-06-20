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

// Integration tests for UTXO cache isolation within transactionHelper.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const ecc = require('tiny-secp256k1')
const ECPair = ECPairFactory(ecc)

const transactionHelper = require('../../../test/transactionHelper')

describe('State Management: UTXO Cache', function () {

    let savedGlobals

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

    function makeAddressInfo() {
        const keyPair = ECPair.makeRandom({ network: bitcoin.networks.regtest })
        const { address } = bitcoin.payments.p2pkh({
            pubkey: keyPair.publicKey,
            network: bitcoin.networks.regtest
        })
        return { address, privateKey: keyPair.privateKey, publicKey: keyPair.publicKey }
    }

    function buildMockPsbt(publicKey, address) {
        const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest })
        const fundingTx = new bitcoin.Transaction()
        fundingTx.version = 2
        fundingTx.addInput(Buffer.alloc(32, 0), 0)
        fundingTx.addOutput(
            bitcoin.payments.p2pkh({ pubkey: publicKey, network: bitcoin.networks.regtest }).output,
            100000
        )
        psbt.addInput({ hash: fundingTx.getHash(), index: 0, nonWitnessUtxo: fundingTx.toBuffer() })
        const data = Buffer.from('TEST', 'utf8')
        psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, data]), value: 0 })
        psbt.addOutput({ address, value: 90000 })
        return psbt.toHex()
    }

    describe('Scenario: Cache consumed after use', function () {

        it('third call for same address gets empty utxos (cache consumed by second call)', async function () {
            const addrInfo = makeAddressInfo()
            const psbtHex = buildMockPsbt(addrInfo.publicKey, addrInfo.address)
            const txid = 'cache' + '00'.repeat(29)

            let encoderCalls = []
            global.encoderConnector = {
                createTx: async (utxos) => {
                    encoderCalls.push([...utxos])
                    return { encoding: 'opreturn', psbt: psbtHex }
                }
            }
            global.nodeConnector = {
                broadcastTx: async () => txid,
                waitForTx: async () => true,
            }
            global.utxoTrackerConnector = {
                getUtxosFromAddress: async () => ({
                    utxos: [{ txid, vout: 1, value: 90000, confirmations: 1 }]
                })
            }

            await transactionHelper.createAndSendTransaction(addrInfo, 'TEST')
            await transactionHelper.createAndSendTransaction(addrInfo, 'TEST2')
            await transactionHelper.createAndSendTransaction(addrInfo, 'TEST3')

            assert.strictEqual(encoderCalls.length, 3)
            assert.deepStrictEqual(encoderCalls[0], [], 'call 1: empty utxo list')
            assert.strictEqual(encoderCalls[1].length, 1, 'call 2: cached utxo')
            assert.strictEqual(encoderCalls[2].length, 1, 'call 3: re-cached from call 2')
        })
    })

    describe('Scenario: Cache miss for different addresses', function () {

        it('two different addresses never share cache', async function () {
            const addr1 = makeAddressInfo()
            const addr2 = makeAddressInfo()
            const psbt1 = buildMockPsbt(addr1.publicKey, addr1.address)
            const psbt2 = buildMockPsbt(addr2.publicKey, addr2.address)
            const txid = 'multi' + '00'.repeat(29)

            let callIndex = 0
            let encoderCalls = []
            global.encoderConnector = {
                createTx: async (utxos, pubkey) => {
                    encoderCalls.push({ utxos: [...utxos], address: pubkey })
                    callIndex++
                    // Return the correct PSBT for the address
                    if (pubkey === addr1.address) return { encoding: 'opreturn', psbt: psbt1 }
                    return { encoding: 'opreturn', psbt: psbt2 }
                }
            }
            global.nodeConnector = {
                broadcastTx: async () => txid,
                waitForTx: async () => true,
            }
            global.utxoTrackerConnector = {
                getUtxosFromAddress: async () => ({
                    utxos: [{ txid, vout: 0, value: 90000, confirmations: 1 }]
                })
            }

            await transactionHelper.createAndSendTransaction(addr1, 'TEST1')
            await transactionHelper.createAndSendTransaction(addr2, 'TEST2')
            await transactionHelper.createAndSendTransaction(addr1, 'TEST3')

            assert.strictEqual(encoderCalls[0].utxos.length, 0, 'addr1 call 1: no cache')
            assert.strictEqual(encoderCalls[1].utxos.length, 0, 'addr2 call 1: no cache (different addr)')
        })
    })
})
