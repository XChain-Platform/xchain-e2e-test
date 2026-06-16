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

// Chaos Experiment 4: Malformed Encoder Response (@P1)
//
// Verifies that when the encoder returns invalid PSBT hex,
// transactionHelper.createAndSendTransaction throws before
// broadcasting anything to the node.

const assert = require('assert')
const sinon = require('sinon')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const ecc = require('tiny-secp256k1')
const ECPair = ECPairFactory(ecc)
const { saveGlobals, restoreGlobals, GLOBAL_KEYS } = require('./chaos-helpers')
const transactionHelper = require('../transactionHelper')

describe('Chaos Experiment 4 — Malformed Encoder Response @P1', function () {

    let saved
    let addressInfo
    let broadcastStub

    before(function () {
        // Generate a real key pair for PSBT signing path
        const keyPair = ECPair.makeRandom({ network: bitcoin.networks.regtest })
        const { address } = bitcoin.payments.p2pkh({
            pubkey: keyPair.publicKey,
            network: bitcoin.networks.regtest
        })
        addressInfo = {
            address: address,
            privateKey: keyPair.privateKey,
            publicKey: keyPair.publicKey
        }
    })

    beforeEach(function () {
        saved = saveGlobals(GLOBAL_KEYS)
        global.NETWORK_OBJECT = bitcoin.networks.regtest
        broadcastStub = sinon.stub()
        global.nodeConnector = {
            broadcastTx: broadcastStub,
            waitForTx: sinon.stub().resolves(true),
            getTransactionHex: sinon.stub().resolves('aabb')
        }
        global.utxoTrackerConnector = {
            getUtxosFromAddress: sinon.stub().resolves({ utxos: [] })
        }
    })

    afterEach(function () {
        restoreGlobals(saved)
        sinon.restore()
    })

    it('throws when encoder returns completely invalid hex', async function () {
        global.encoderConnector = {
            createTx: sinon.stub().resolves({
                encoding: 'opreturn',
                psbt: 'NOT_VALID_HEX_AT_ALL'
            })
        }

        await assert.rejects(
            () => transactionHelper.createAndSendTransaction(addressInfo, 'ISSUE|0|CHAOS'),
            (err) => {
                assert(err instanceof Error, 'should throw an Error')
                return true
            }
        )
        assert(broadcastStub.notCalled, 'broadcastTx must not be called with invalid PSBT')
    })

    it('throws when encoder returns truncated PSBT hex', async function () {
        global.encoderConnector = {
            createTx: sinon.stub().resolves({
                encoding: 'opreturn',
                psbt: '70736274ff' // PSBT magic bytes but truncated
            })
        }

        await assert.rejects(
            () => transactionHelper.createAndSendTransaction(addressInfo, 'ISSUE|0|CHAOS')
        )
        assert(broadcastStub.notCalled, 'broadcastTx must not be called with truncated PSBT')
    })

    it('throws when encoder returns empty string as PSBT', async function () {
        global.encoderConnector = {
            createTx: sinon.stub().resolves({
                encoding: 'opreturn',
                psbt: ''
            })
        }

        await assert.rejects(
            () => transactionHelper.createAndSendTransaction(addressInfo, 'ISSUE|0|CHAOS')
        )
        assert(broadcastStub.notCalled)
    })

    it('throws when encoder returns null PSBT', async function () {
        global.encoderConnector = {
            createTx: sinon.stub().resolves({
                encoding: 'opreturn',
                psbt: null
            })
        }

        await assert.rejects(
            () => transactionHelper.createAndSendTransaction(addressInfo, 'ISSUE|0|CHAOS')
        )
        assert(broadcastStub.notCalled)
    })

    it('throws when encoder itself rejects', async function () {
        global.encoderConnector = {
            createTx: sinon.stub().rejects(new Error('Error trying to create a tx with the encoder module'))
        }

        await assert.rejects(
            () => transactionHelper.createAndSendTransaction(addressInfo, 'ISSUE|0|CHAOS'),
            /encoder module/
        )
        assert(broadcastStub.notCalled)
    })
})
