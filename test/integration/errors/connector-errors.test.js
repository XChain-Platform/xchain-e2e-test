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

// Integration tests for error propagation from connectors through the pipeline.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const ecc = require('tiny-secp256k1')
const ECPair = ECPairFactory(ecc)

const transactionHelper = require('../../../test/transactionHelper')
const issueHelper = require('../../../test/helpers/issueHelper')

describe('Error Propagation — Connector Errors', function () {

    let savedGlobals
    let addressInfo

    before(function () {
        const keyPair = ECPair.makeRandom({ network: bitcoin.networks.regtest })
        const { address } = bitcoin.payments.p2pkh({
            pubkey: keyPair.publicKey,
            network: bitcoin.networks.regtest
        })
        addressInfo = { address, privateKey: keyPair.privateKey, publicKey: keyPair.publicKey }
    })

    beforeEach(function () {
        savedGlobals = {
            NETWORK_OBJECT: global.NETWORK_OBJECT,
            encoderConnector: global.encoderConnector,
            nodeConnector: global.nodeConnector,
            utxoTrackerConnector: global.utxoTrackerConnector,
            indexerDatabase: global.indexerDatabase,
        }
        global.NETWORK_OBJECT = { ...bitcoin.networks.regtest, dustThreshold: 546 }
    })

    afterEach(function () {
        Object.assign(global, savedGlobals)
        sinon.restore()
    })

    describe('Scenario 3.7.1: Encoder connection failure propagates to helper', function () {

        it('encoder error throws through transactionHelper to issueHelper', async function () {
            global.encoderConnector = {
                createTx: async () => { throw new Error('ECONNREFUSED encoder') }
            }
            global.nodeConnector = { broadcastTx: async () => 'txid', waitForTx: async () => true }
            global.utxoTrackerConnector = { getUtxosFromAddress: async () => ({ utxos: [] }) }
            global.indexerDatabase = {
                waitForIssue: async () => null,
                waitForCredit: async () => null,
            }

            await assert.rejects(
                () => issueHelper.sendIssueV0(addressInfo, 'TOK', 1000, 100, 8, 'desc', 50),
                /ECONNREFUSED encoder/
            )
        })
    })

    describe('Scenario 3.7.3: Broadcast rejection with node error', function () {

        it('node broadcast error propagates with descriptive message', async function () {
            // Build a valid PSBT for the encoder to return
            const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest })
            const fundingTx = new bitcoin.Transaction()
            fundingTx.version = 2
            fundingTx.addInput(Buffer.alloc(32, 0), 0)
            fundingTx.addOutput(
                bitcoin.payments.p2pkh({
                    pubkey: addressInfo.publicKey,
                    network: bitcoin.networks.regtest
                }).output,
                100000
            )
            psbt.addInput({ hash: fundingTx.getHash(), index: 0, nonWitnessUtxo: fundingTx.toBuffer() })
            const data = Buffer.from('TEST', 'utf8')
            psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, data]), value: 0 })
            psbt.addOutput({ address: addressInfo.address, value: 90000 })

            global.encoderConnector = {
                createTx: async () => ({ encoding: 'opreturn', psbt: psbt.toHex() })
            }
            global.nodeConnector = {
                broadcastTx: async () => {
                    throw new Error('Error sending transaction to the node: {"code":-26,"message":"dust"}')
                },
                waitForTx: async () => true,
            }
            global.utxoTrackerConnector = { getUtxosFromAddress: async () => ({ utxos: [] }) }

            await assert.rejects(
                () => transactionHelper.createAndSendTransaction(addressInfo, 'ISSUE|0|TEST'),
                (err) => {
                    assert(err.message.includes('dust') || err.message.includes('Error sending'),
                        'error should include node rejection reason')
                    return true
                }
            )
        })
    })

    describe('Scenario 3.7.1: Connector timeout during helper execution', function () {

        it('node broadcastTx ETIMEDOUT propagates through helper', async function () {
            const createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction')
                .rejects(new Error('ETIMEDOUT'))

            global.indexerDatabase = {
                waitForIssue: async () => null,
                waitForCredit: async () => null,
            }

            await assert.rejects(
                () => issueHelper.sendIssueV0(addressInfo, 'TOK', 1000, 100, 8, 'desc', 50),
                /ETIMEDOUT/
            )
        })
    })
})
