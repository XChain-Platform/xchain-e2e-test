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
const {ECPairFactory} = require('ecpair')
const {transactionState} = require('./01_create_and_send_transaction')

// Satoshi amounts are handled as BigInt end to end. The tracker serves values
// as decimal strings, and a Dogecoin output can exceed Number.MAX_SAFE_INTEGER
// (about 90.07M DOGE), where parseInt silently rounds by a few sat.
function toSats(value) {
    return typeof value === 'bigint' ? value : BigInt(String(value))
}

// Stock bitcoinjs-lib serializes a 64-bit value through a Number writer that
// refuses anything above 2^53-1, so an output past that ceiling is rejected
// here with a clear message instead of an opaque RangeError from inside it.
function toSerializableNumber(sats, label) {
    if (sats > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(label + " of " + sats + " sat exceeds the 2^53-1 sat a bitcoinjs-lib output can hold")
    }
    return Number(sats)
}

// Legacy (non-segwit) spend built without Psbt. Psbt needs the whole previous
// transaction as nonWitnessUtxo and parses it with the stock reader, which
// throws on any output above 2^53-1 sat, and its output typeforce caps values
// at 21e14 sat, below what a single Dogecoin output can carry. A legacy
// SIGHASH_ALL signature commits only to the previous output's script, never
// its value, so the previous transaction is not needed at all.
function buildLegacySpend(addressInfo, selectedUtxos, outputs) {
    const ECPair = ECPairFactory(ecc)
    const keyToSign = ECPair.fromPrivateKey(addressInfo["privateKey"], { network: NETWORK_OBJECT })
    const pubkey = Buffer.from(keyToSign.publicKey)
    const ownScript = bitcoin.payments.p2pkh({ pubkey, network: NETWORK_OBJECT }).output

    const tx = new bitcoin.Transaction()
    // Same version Psbt uses, so the signed bytes match the Psbt-built form.
    tx.version = 2
    for (const utxo of selectedUtxos) {
        tx.addInput(Buffer.from(utxo.txid, 'hex').reverse(), utxo.vout, 0xffffffff)
    }
    // Pushed directly rather than through addOutput, whose Satoshi typeforce
    // stops at 21e14 sat; the 2^53-1 serializer ceiling is checked above.
    for (const out of outputs) {
        tx.outs.push({
            script: bitcoin.address.toOutputScript(out.address, NETWORK_OBJECT),
            value: toSerializableNumber(out.value, "output")
        })
    }

    const hashType = bitcoin.Transaction.SIGHASH_ALL
    selectedUtxos.forEach((utxo, inputIndex) => {
        const prevScript = utxo.scriptPubKey ? Buffer.from(utxo.scriptPubKey, 'hex') : ownScript
        if (!prevScript.equals(ownScript)) {
            throw new Error("Can not sign for input #"+inputIndex+": its script is not the P2PKH script of "+addressInfo["address"])
        }
        const hash = tx.hashForSignature(inputIndex, prevScript, hashType)
        const signature = bitcoin.script.signature.encode(Buffer.from(keyToSign.sign(hash)), hashType)
        tx.setInputScript(inputIndex, bitcoin.payments.p2pkh({ signature, pubkey, network: NETWORK_OBJECT }).input)
    })
    return tx
}

module.exports = {
    async createSimpleTransaction(addressInfo, destinationAddress, amount){
        if (transactionState.verifiedUtxosAddress === addressInfo["address"]) {
            transactionState.verifiedUtxos = null
            transactionState.verifiedUtxosAddress = null
        }
        const psbt = new bitcoin.Psbt({ network: NETWORK_OBJECT })
        const feePerBytes = await nodeConnector.getFeePerKilobyte(1)/1000

        const utxoSequence = 0xffffffff
        let inputSatoshis = 0n
        const amountSatoshis = toSats(amount)

        utxosList = await utxoTrackerConnector.getUtxosFromAddress(addressInfo["address"])
        utxosList = utxosList["utxos"]

        if ((utxosList == null) || (utxosList.length == 0)){
            throw new Error("couldn't find any utxos for address "+addressInfo["address"])
        }

        let utxoIndex = 0
        while (utxoIndex < utxosList.length){
            const nextUtxo = utxosList[utxoIndex]

            let utxoDupIndex = utxoIndex + 1
            while (utxoDupIndex < utxosList.length){
                const nextUtxoDup = utxosList[utxoDupIndex]

                if ((nextUtxoDup.txid == nextUtxo.txid) && (nextUtxoDup.vout == nextUtxo.vout)){
                    utxosList.splice(utxoDupIndex, 1)
                } else {
                    utxoDupIndex = utxoDupIndex + 1
                }
            }

            utxoIndex = utxoIndex+1
        }

        // Largest first, compared as BigInt: subtracting the served strings
        // coerces them to Number and ties values that differ only above 2^53.
        utxosList.sort((a, b) => {
            const av = toSats(a.value)
            const bv = toSats(b.value)
            return av === bv ? 0 : (bv > av ? 1 : -1)
        })

        const estimatedFee = toSats(NETWORK_OBJECT.dustThreshold)

        const selectedUtxos = []
        let nextUtxoIndex = 0
        while (nextUtxoIndex < utxosList.length){
            const nextUtxo = utxosList[nextUtxoIndex]
            selectedUtxos.push(nextUtxo)
            inputSatoshis = inputSatoshis + toSats(nextUtxo.value)

            if (inputSatoshis > amountSatoshis + estimatedFee){
                break
            }

            nextUtxoIndex = nextUtxoIndex + 1
        }

        const changeSatoshis = inputSatoshis - amountSatoshis - estimatedFee

        const outputs = [{ address: destinationAddress, value: amountSatoshis }]
        if (changeSatoshis > 0n) {
            outputs.push({ address: addressInfo["address"], value: changeSatoshis })
        }

        let tx
        if (!selectedUtxos.some(utxo => this.isSegwitUTXO(utxo))) {
            tx = buildLegacySpend(addressInfo, selectedUtxos, outputs)
        } else {
            for (const nextUtxo of selectedUtxos) {
                if (this.isSegwitUTXO(nextUtxo)){
                    psbt.addInput({
                        hash: nextUtxo.txid,
                        index: nextUtxo.vout,
                        sequence: utxoSequence,
                        witnessUtxo: {
                            script: Buffer.from(nextUtxo.scriptPubKey, 'hex'),
                            value: toSerializableNumber(toSats(nextUtxo.value), "segwit input"),
                        }
                    })
                } else {
                    const wholeUtxoHex = await nodeConnector.getTransactionHex(nextUtxo.txid)
                    psbt.addInput({
                        hash: nextUtxo.txid,
                        index: nextUtxo.vout,
                        sequence: utxoSequence,
                        nonWitnessUtxo: Buffer.from(wholeUtxoHex, 'hex')
                    })
                }
            }

            for (const out of outputs) {
                psbt.addOutput({ address: out.address, value: toSerializableNumber(out.value, "output") })
            }

            const ECPair = ECPairFactory(ecc);
            const keyToSign = ECPair.fromPrivateKey(addressInfo["privateKey"], { NETWORK_OBJECT });

            for (const proxInputIndex in psbt.data.inputs){
                psbt.signInput(parseInt(proxInputIndex), keyToSign);
            }

            psbt.finalizeAllInputs();
            psbt.setMaximumFeeRate(100000)
            tx = psbt.extractTransaction()
        }
        let txHash = tx.getId()
        const txHex = tx.toHex()

        console.log("Sending a simple transaction... (hex length: "+txHex.length+")")
        txHash = await nodeConnector.broadcastTx(txHex)
        console.log("Waiting for the simple transaction ("+txHash+") to be confirmed...")
        const txExists = await nodeConnector.waitForTx(txHash, 60000)

        // Wait for confirmed UTXOs only; ignore stale mempool entries.
        console.log("Waiting for the utxo-tracker to index confirmed UTXOs from simple tx "+txHash+"...")
        const trackerEnd2 = Date.now() + 20000
        while (Date.now() < trackerEnd2) {
            try {
                const result = await utxoTrackerConnector.getUtxosFromAddress(addressInfo["address"])
                const utxos = result["utxos"] || []
                const confirmedUtxos = utxos.filter(u => u.confirmations > 0)
                if (confirmedUtxos.some(u => u.txid === txHash)) {
                    transactionState.verifiedUtxos = confirmedUtxos
                    transactionState.verifiedUtxosAddress = addressInfo["address"]
                    break
                }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 500))
        }
        if (!transactionState.verifiedUtxos) {
            try {
                const result = await utxoTrackerConnector.getUtxosFromAddress(addressInfo["address"])
                const utxos = result["utxos"] || []
                transactionState.verifiedUtxos = utxos.filter(u => u.confirmations > 0)
                transactionState.verifiedUtxosAddress = addressInfo["address"]
            } catch (e) {}
        }

        return txHash
    }
}
