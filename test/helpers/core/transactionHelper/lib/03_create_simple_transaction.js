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

module.exports = {
    async createSimpleTransaction(addressInfo, destinationAddress, amount){
        if (transactionState.verifiedUtxosAddress === addressInfo["address"]) {
            transactionState.verifiedUtxos = null
            transactionState.verifiedUtxosAddress = null
        }
        const psbt = new bitcoin.Psbt({ network: NETWORK_OBJECT })
        const feePerBytes = await nodeConnector.getFeePerKilobyte(1)/1000

        const utxoSequence = 0xffffffff
        let inputSatoshis = 0

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

        utxosList.sort((a,b)=> b.value - a.value)

        const estimatedFee = NETWORK_OBJECT.dustThreshold

        let nextUtxoIndex = 0
        while (nextUtxoIndex < utxosList.length){
            const nextUtxo = utxosList[nextUtxoIndex]
            nextUtxo.value = parseInt(nextUtxo.value)

            if (this.isSegwitUTXO(nextUtxo)){
                const nextInput = {
                    hash: nextUtxo.txid,
                    index: nextUtxo.vout,
                    sequence: utxoSequence,
                    witnessUtxo: {
                        script: Buffer.from(nextUtxo.scriptPubKey, 'hex'),
                        value: nextUtxo.value,
                    }
                }
                psbt.addInput(nextInput)
                inputSatoshis = inputSatoshis + nextUtxo.value
            } else {
                const wholeUtxoHex = await nodeConnector.getTransactionHex(nextUtxo.txid)
                const nextInput = {
                    hash: nextUtxo.txid,
                    index: nextUtxo.vout,
                    sequence: utxoSequence,
                    nonWitnessUtxo: Buffer.from(wholeUtxoHex, 'hex')
                }
                psbt.addInput(nextInput)
                inputSatoshis = inputSatoshis + nextUtxo.value
            }

            if (inputSatoshis > amount + estimatedFee){
                break
            }

            nextUtxoIndex = nextUtxoIndex + 1
        }

        const changeSatoshis = inputSatoshis - amount - estimatedFee

        psbt.addOutput({
            address: destinationAddress,
            value: amount
        })

        if (changeSatoshis > 0) {
            psbt.addOutput({
                address: addressInfo["address"],
                value: changeSatoshis
            })
        }

        const ECPair = ECPairFactory(ecc);
        const keyToSign = ECPair.fromPrivateKey(addressInfo["privateKey"], { NETWORK_OBJECT });

        for (const proxInputIndex in psbt.data.inputs){
            const proxInput = psbt.data.inputs[proxInputIndex]
            psbt.signInput(parseInt(proxInputIndex), keyToSign);
        }

        psbt.finalizeAllInputs();
        psbt.setMaximumFeeRate(100000)
        const tx = psbt.extractTransaction()
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
