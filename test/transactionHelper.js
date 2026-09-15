// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const ecc = require('tiny-secp256k1')
const bitcoin = require('bitcoinjs-lib')
const {createAndSendTransaction} = require('./transactionHelper/lib/01_create_and_send_transaction')
const {_doCreateAndSendTransaction} = require('./transactionHelper/lib/02_do_create_and_send_transaction')
const {createSimpleTransaction} = require('./transactionHelper/lib/03_create_simple_transaction')

// Taproot needs the ECC backend registered before any p2tr payment is built or
// any script-path input is finalized; without it bitcoinjs-lib throws
// "ecc library invalid" from inside finalizeAllInputs on the envelope reveal.
bitcoin.initEccLib(ecc)

module.exports = {
    createAndSendTransaction,

    // Sign a Taproot envelope reveal. Input 0 is a script-path spend of the
    // envelope leaf, so it takes a Schnorr signature under the internal key rather
    // than the ECDSA signature every other lane uses.
    //
    // `expectedCommitTxid` is not optional in spirit: the reveal is pre-built
    // against the UNSIGNED commit's txid (§3.5), and if that txid drifted the reveal
    // spends nothing while the commit's value sits in a one-time P2TR output no
    // other transaction references. That is a stranded-funds bug, so it is checked
    // here, before either half can be broadcast, rather than discovered on chain.
    signEnvelopeReveal(addressInfo, revealPsbtHex, expectedCommitTxid){
        if (!revealPsbtHex){
            throw new Error("encoder returned TAPROOT without a revealPsbt; the pair cannot be completed")
        }
        const revealPsbt = bitcoin.Psbt.fromHex(revealPsbtHex, { network: NETWORK_OBJECT })

        // Checked BEFORE signing, not after: there is nothing to salvage from a
        // signature over the wrong outpoint, and failing here keeps the guard true of
        // the pre-built reveal rather than of something we just produced.
        const revealPrevout = Buffer.from(revealPsbt.txInputs[0].hash).reverse().toString('hex')
        if (revealPrevout !== expectedCommitTxid){
            throw new Error("the reveal does not spend the signed commit (reveal prevout "+revealPrevout+" vs commit "+expectedCommitTxid+")")
        }

        const envelopePubKey = Buffer.from(addressInfo["publicKey"])
        const envelopePrivKey = Buffer.from(addressInfo["privateKey"])
        revealPsbt.signInput(0, {
            publicKey: envelopePubKey,
            signSchnorr: (hash) => Buffer.from(ecc.signSchnorr(hash, envelopePrivKey))
        })
        revealPsbt.finalizeAllInputs()
        revealPsbt.setMaximumFeeRate(100000)
        return revealPsbt.extractTransaction()
    },

    _doCreateAndSendTransaction,

    isSegwitUTXO(utxo) {
        try {
            const script = bitcoin.script.decompile(Buffer.from(utxo.scriptPubKey, 'hex'));
            
            return script[0] === 0x00;
        } catch (error) {
            return false;
        }
    },

    createSimpleTransaction
}
