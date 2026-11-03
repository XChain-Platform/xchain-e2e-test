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

// createSimpleTransaction must spend a legacy output above 2^53-1 sat (a
// single Dogecoin output can hold more than about 90.07M DOGE) with exactly
// the intended fee: no RangeError from parsing the previous transaction and
// no parseInt rounding of the tracker's string values.

const assert = require('assert')
const crypto = require('crypto')
const ecc = require('tiny-secp256k1')
const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const CryptoNetworks = require('../../../src/crypto_networks')
const transactionHelper = require('../../helpers/core/transactionHelper')

const ECPair = ECPairFactory(ecc)
const network = CryptoNetworks.getBitcoinJsNetwork('dogecoin-regtest')
const FEE = BigInt(network.dustThreshold)
const AMOUNT = 100000000

function sha256d(buf) {
    return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest()
}

function txidOf(buf) {
    return Buffer.from(sha256d(buf)).reverse().toString('hex')
}

// Hand-serialized legacy transaction, so an output value above 2^53-1 can be
// written exactly (stock bitcoinjs-lib refuses to serialize it).
function rawLegacyTx(outputs, seed) {
    const parts = [Buffer.from('01000000', 'hex'), Buffer.from([1])]
    parts.push(crypto.createHash('sha256').update(String(seed)).digest())
    parts.push(Buffer.from('00000000', 'hex'), Buffer.from([0]), Buffer.from('ffffffff', 'hex'))
    parts.push(Buffer.from([outputs.length]))
    for (const out of outputs) {
        const v = Buffer.alloc(8)
        v.writeBigUInt64LE(out.value)
        parts.push(v, Buffer.from([out.script.length]), out.script)
    }
    parts.push(Buffer.from('00000000', 'hex'))
    return Buffer.concat(parts)
}

function makeWallet(fill) {
    const privateKey = Buffer.alloc(32, fill)
    const keyPair = ECPair.fromPrivateKey(privateKey, { network })
    const pubkey = Buffer.from(keyPair.publicKey)
    const payment = bitcoin.payments.p2pkh({ pubkey, network })
    return { address: payment.address, privateKey, publicKey: pubkey, script: payment.output }
}

// Stub connectors: the tracker serves the given utxos (values as strings, as
// the real tracker does), the node serves each previous tx hex, and the
// broadcast hex is captured. After broadcast the tracker reports the new tx as
// confirmed so the helper's post-broadcast wait ends at once.
function installRail(utxos, prevTxHexById) {
    const captured = { broadcasts: [] }
    global.NETWORK_OBJECT = network
    global.nodeConnector = {
        getFeePerKilobyte: async () => 0.01,
        getTransactionHex: async (txid) => prevTxHexById[txid],
        broadcastTx: async (hex) => {
            captured.broadcasts.push(hex)
            return txidOf(Buffer.from(hex, 'hex'))
        },
        waitForTx: async () => true,
    }
    global.utxoTrackerConnector = {
        getUtxosFromAddress: async () => {
            if (captured.broadcasts.length === 0) {
                return { utxos: utxos.map(u => ({ ...u })) }
            }
            const last = captured.broadcasts[captured.broadcasts.length - 1]
            return { utxos: [{ txid: txidOf(Buffer.from(last, 'hex')), vout: 1, value: '1', confirmations: 1 }] }
        },
    }
    return captured
}

function fundingUtxo(wallet, valueStr, seed) {
    const raw = rawLegacyTx([{ value: BigInt(valueStr), script: wallet.script }], seed)
    const txid = txidOf(raw)
    return {
        utxo: { txid, vout: 0, value: valueStr, scriptPubKey: wallet.script.toString('hex'), confirmations: 1 },
        hex: raw.toString('hex'),
    }
}

// Every input's signature must verify against the legacy sighash of the
// broadcast tx, so the existing callers still get a spend the node accepts.
function assertSignaturesValid(tx, wallet) {
    tx.ins.forEach((input, i) => {
        const [sigBuf, pubkey] = bitcoin.script.decompile(input.script)
        assert.ok(Buffer.from(pubkey).equals(wallet.publicKey), 'input ' + i + ' pubkey')
        const { signature, hashType } = bitcoin.script.signature.decode(sigBuf)
        const hash = tx.hashForSignature(i, wallet.script, hashType)
        assert.ok(ECPair.fromPublicKey(wallet.publicKey).verify(hash, signature), 'input ' + i + ' signature verifies')
    })
}

describe('createSimpleTransaction with output values above 2^53-1 sat', function () {
    const savedGlobals = {}

    before(function () {
        for (const k of ['NETWORK_OBJECT', 'nodeConnector', 'utxoTrackerConnector']) savedGlobals[k] = global[k]
    })

    after(function () {
        for (const k of Object.keys(savedGlobals)) global[k] = savedGlobals[k]
    })

    it('spends a 9007199254740995 sat legacy output with exactly the intended fee', async function () {
        const sender = makeWallet(0x11)
        const dest = makeWallet(0x22)
        const big = '9007199254740995'
        const f = fundingUtxo(sender, big, 'big')
        const captured = installRail([f.utxo], { [f.utxo.txid]: f.hex })

        const txHash = await transactionHelper.createSimpleTransaction(
            { address: sender.address, privateKey: sender.privateKey, publicKey: sender.publicKey },
            dest.address,
            AMOUNT,
        )

        assert.strictEqual(captured.broadcasts.length, 1)
        const hex = captured.broadcasts[0]
        assert.strictEqual(txHash, txidOf(Buffer.from(hex, 'hex')))
        const tx = bitcoin.Transaction.fromHex(hex)
        assert.strictEqual(tx.ins.length, 1)
        assert.strictEqual(Buffer.from(tx.ins[0].hash).reverse().toString('hex'), f.utxo.txid)
        assert.strictEqual(tx.ins[0].index, 0)

        assert.strictEqual(tx.outs.length, 2)
        assert.ok(Buffer.from(tx.outs[0].script).equals(dest.script))
        assert.strictEqual(BigInt(tx.outs[0].value), BigInt(AMOUNT))
        assert.ok(Buffer.from(tx.outs[1].script).equals(sender.script))
        assert.strictEqual(BigInt(tx.outs[1].value), BigInt(big) - BigInt(AMOUNT) - FEE)

        const outSum = tx.outs.reduce((s, o) => s + BigInt(o.value), 0n)
        assert.strictEqual(BigInt(big) - outSum, FEE)
        assertSignaturesValid(tx, sender)
    })

    it('picks the larger of two utxos whose values differ only above 2^53', async function () {
        const sender = makeWallet(0x33)
        const dest = makeWallet(0x44)
        // Both round to the same Number (9007199254740992), so a Number sort
        // keeps the served order and spends the smaller one.
        const small = fundingUtxo(sender, '9007199254740992', 'small')
        const large = fundingUtxo(sender, '9007199254740993', 'large')
        const captured = installRail([small.utxo, large.utxo], {
            [small.utxo.txid]: small.hex,
            [large.utxo.txid]: large.hex,
        })

        await transactionHelper.createSimpleTransaction(
            { address: sender.address, privateKey: sender.privateKey, publicKey: sender.publicKey },
            dest.address,
            AMOUNT,
        )

        const tx = bitcoin.Transaction.fromHex(captured.broadcasts[0])
        assert.strictEqual(tx.ins.length, 1)
        assert.strictEqual(Buffer.from(tx.ins[0].hash).reverse().toString('hex'), large.utxo.txid)
        assert.strictEqual(BigInt(tx.outs[1].value), 9007199254740993n - BigInt(AMOUNT) - FEE)
        assertSignaturesValid(tx, sender)
    })

    it('builds the same bytes Psbt builds for an ordinary legacy spend', async function () {
        const sender = makeWallet(0x55)
        const dest = makeWallet(0x66)
        const f = fundingUtxo(sender, '500000000', 'ordinary')
        const captured = installRail([f.utxo], { [f.utxo.txid]: f.hex })

        await transactionHelper.createSimpleTransaction(
            { address: sender.address, privateKey: sender.privateKey, publicKey: sender.publicKey },
            dest.address,
            AMOUNT,
        )

        const psbt = new bitcoin.Psbt({ network })
        psbt.addInput({ hash: f.utxo.txid, index: 0, sequence: 0xffffffff, nonWitnessUtxo: Buffer.from(f.hex, 'hex') })
        psbt.addOutput({ address: dest.address, value: AMOUNT })
        psbt.addOutput({ address: sender.address, value: Number(500000000n - BigInt(AMOUNT) - FEE) })
        psbt.signInput(0, ECPair.fromPrivateKey(sender.privateKey, { network }))
        psbt.finalizeAllInputs()
        assert.strictEqual(captured.broadcasts[0], psbt.extractTransaction().toHex())
    })

    it('refuses a change output past the 2^53-1 serializer ceiling before broadcasting', async function () {
        const sender = makeWallet(0x77)
        const dest = makeWallet(0x88)
        const f = fundingUtxo(sender, '18014398509481984', 'huge')
        const captured = installRail([f.utxo], { [f.utxo.txid]: f.hex })

        await assert.rejects(
            () => transactionHelper.createSimpleTransaction(
                { address: sender.address, privateKey: sender.privateKey, publicKey: sender.publicKey },
                dest.address,
                AMOUNT,
            ),
            /exceeds the 2\^53-1 sat/,
        )
        assert.strictEqual(captured.broadcasts.length, 0)
    })
})
