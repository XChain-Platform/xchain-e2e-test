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
const psbtutils = require('bitcoinjs-lib/src/psbt/psbtutils')
const {transactionState} = require('./01_create_and_send_transaction')

function xchainP2shFinalizer(inputIndex, input, script, isSegwit, isP2SH, isP2WSH){
    if (isP2SH){
        const decompiled = bitcoin.script.decompile(script);

        let payment = {
            network: bitcoin.networks.regtest,
            input:
                bitcoin.script.compile([
                    input.partialSig[0].signature,
                    input.partialSig[0].pubkey
                ]),
            output:script
        }

        payment = bitcoin.payments.p2sh({
            network: bitcoin.networks.regtest,
            redeem: payment,
        });

        return {
            finalScriptSig: payment.input,
            finalScriptWitness:undefined
        };
    } else if (isP2WSH){
        const decompiled = bitcoin.script.decompile(script);

        let payment = {
            network: bitcoin.networks.regtest,
            input:
                bitcoin.script.compile([
                    input.partialSig[0].signature,
                    input.partialSig[0].pubkey
                ]),
            output:script
        }

        payment = bitcoin.payments.p2wsh({
            network: bitcoin.networks.regtest,
            redeem: payment,
        });

        return {
            finalScriptSig: undefined,//payment.input,
            finalScriptWitness: psbtutils.witnessStackToScriptWitness(payment.witness)
        };
    } else {
        throw new Error(`Can not finalize input #${inputIndex}. This finalizer is meant for only p2sh inputs`);
    }


    const decompiled = bitcoin.script.decompile(script);

}

module.exports = {
    async _doCreateAndSendTransaction(addressInfo, data, rawData = null, customOutputs = [], outputType = null, compressedPubKey = null, opts = {}){
        console.log("Creating the transaction...")
        const utxoListForEncoder = (transactionState.verifiedUtxosAddress === addressInfo["address"] && transactionState.verifiedUtxos) ? transactionState.verifiedUtxos : []
        transactionState.verifiedUtxos = null
        transactionState.verifiedUtxosAddress = null
        const capture = opts && opts.capture ? opts.capture : null
        let txPsbtHex = await encoderConnector.createTx(
            utxoListForEncoder, //utxoList - use cached confirmed UTXOs if available
            addressInfo["address"], //pubkey
            customOutputs, //customOutputs - payment outputs (e.g., COINPay)
            data,
            rawData, //rawData
            null, //TEST_FEE, //exact_fee
            false, //rbf - false, it's not needed for this test
            outputType, //outputType - null = encoder picks; "P2SH" forces the P2SH 2-tx path (handler supports it)
            addressInfo["address"], //changeAddress - the bitcoins will return to the same address
            null, //p2shHash
            null, //p2shHex
            compressedPubKey, //compressedPubKey - the 3rd key of the 1-of-3 multisig; required to exercise the MULTISIGN path
            // unconfirmed=false: e2e test traffic always waits for confirmation
            // before issuing the next tx, so we should never need to spend a
            // mempool UTXO. Filtering them out at the encoder defends against
            // the tracker's mempool DB carrying stale entries (a node-side
            // dropped tx that the tracker's 60s mempool poll hasn't yet
            // reconciled; see STALE-UTXO TRAP log).
            false,
            (opts && opts.compress !== undefined) ? opts.compress : null
        )

        let built = txPsbtHex
        let encodeType = txPsbtHex["encoding"]
        txPsbtHex = txPsbtHex["psbt"]
        if (capture){
            capture.encoding = encodeType
            capture.compression = built["compression"] || null
            capture.envelope = built["envelope"] || null
            capture.carrierScripts = built["carrierScripts"] || null
        }

        let psbtToSign = bitcoin.Psbt.fromHex(txPsbtHex)
        var ECPair = ECPairFactory(ecc);
        let keyToSign = ECPair.fromPrivateKey(addressInfo["privateKey"], { NETWORK_OBJECT });

        for (let proxInputIndex in psbtToSign.data.inputs){
            let proxInput = psbtToSign.data.inputs[proxInputIndex]
            psbtToSign.signInput(parseInt(proxInputIndex), keyToSign);
        }

        psbtToSign.finalizeAllInputs();
        psbtToSign.setMaximumFeeRate(100000) // regtest fee estimates can exceed bitcoinjs-lib's default 5000 sat/byte threshold
        let tx = psbtToSign.extractTransaction()
        let txHash = tx.getId()
        let txHex = tx.toHex()

        let spentTx = null
        let spentHex = null
        // TAPROOT is also a two-transaction scheme, but ONE create_tx call
        // returns both halves (spec §6): the reveal is pre-built against the unsigned
        // commit's txid, which only holds because every commit input is segwit (§3.5).
        // There is no second encoder call and no funding-tx hash to hand back, so this
        // branch signs the reveal the encoder already gave us. Input 0 is the commit
        // outpoint by construction (§3.5) and is a script-path spend of the envelope
        // leaf, so it takes a Schnorr signature rather than the ECDSA one every other
        // lane uses.
        if (encodeType == "TAPROOT"){
            console.log("Signing the envelope reveal (the encode type TAPROOT was chosen)...")
            spentTx = this.signEnvelopeReveal(addressInfo, built["revealPsbt"], txHash)
            spentHex = spentTx.toHex()
        }
        // P2SH and P2WSH are both two-transaction schemes: tx1 creates the
        // data-bearing outputs (P2SH redeem scripts / P2WSH witness scripts),
        // tx2 spends them to reveal the payload chunks on-chain. The encoder
        // builds the spending PSBT for either encoding when handed tx1's hash +
        // hex; xchainP2shFinalizer auto-detects P2SH vs P2WSH per input and
        // produces the right scriptSig (P2SH) or witness (P2WSH). Large payloads
        // (e.g. an ~8 KB FILE) fan out across several P2WSH outputs, so tx2 can
        // carry multiple witness-revealing inputs.
        if (encodeType == "P2SH" || encodeType == "P2WSH"){
            console.log("Creating the second transaction (the encode type "+encodeType+" was chosen)...")
            let spentTxPsbtHex = await encoderConnector.createTx(
                [], //utxoList - the encoder will find the utxos
                addressInfo["address"], //pubkey
                // customOutputs must ride the REVEAL tx (the tx the indexer treats as
                // the action): the encoder folds their value into the funding output on
                // tx1 and emits them only when passed again here, so passing the same
                // list to both phases pays them exactly once (mirrors the SDK's
                // lifecycleManager). Passing [] here silently dropped the native-fee
                // output on every P2SH/P2WSH action, failing all long-payload
                // fee-bearing tests on LTC/DOGE ('insufficient fee').
                customOutputs,
                data,
                rawData, //rawData
                null, //TEST_FEE, //exact_fee
                false, //rbf - false, it's not needed for this test
                outputType, //outputType - propagate the caller's choice (null = auto, "P2SH" = forced)
                addressInfo["address"], //changeAddress - the bitcoins will return to the same address
                txHash,
                txHex,
                null,
                false,  // unconfirmed=false; see comment above
                // The SAME compression choice as the funding call, and not the
                // encoder's default: the chunk lane commits to the payload in the
                // funding tx's redeem/witness scripts and reproduces it here, so a
                // reveal that compressed when the funding tx did not would hash to
                // different scripts and be unspendable.
                (opts && opts.compress !== undefined) ? opts.compress : null
            )

            spentTxPsbtHex = spentTxPsbtHex["psbt"]

            let spentPsbtToSign = bitcoin.Psbt.fromHex(spentTxPsbtHex)

            for (let proxInputIndex in spentPsbtToSign.data.inputs){
                let proxInput = spentPsbtToSign.data.inputs[proxInputIndex]
                spentPsbtToSign.signInput(parseInt(proxInputIndex), keyToSign);
            }

            // Every input in the spent tx carries an XChain payload chunk
            // (large action data like DEPLOY code or a multi-KB FILE is split
            // across multiple P2SH/P2WSH inputs by the encoder). All of them
            // need the custom finalizer, which detects the per-input encoding.
            for (let i = 0; i < spentPsbtToSign.data.inputs.length; i++) {
                spentPsbtToSign.finalizeInput(i, xchainP2shFinalizer);
            }
            spentPsbtToSign.setMaximumFeeRate(100000)
            spentTx = spentPsbtToSign.extractTransaction()
            spentHex = spentTx.toHex()
        }

        console.log("Sending the transaction... (hex length: "+txHex.length+")")
        txHash = await nodeConnector.broadcastTx(txHex)
        let spentTxHash = null

        if (spentHex != null){
            console.log("Sending the second transaction... (hex length: "+spentHex.length+")")
            spentTxHash = await nodeConnector.broadcastTx(spentHex)
        }
        if (capture){
            capture.fundingTxHash = txHash
            capture.revealTxHash = spentTxHash
            capture.revealWeight = spentTx ? spentTx.weight() : null
        }
        console.log("Waiting for the transaction ("+txHash+") to be confirmed...")
        let txExists = await nodeConnector.waitForTx(txHash, 60000)

        if (spentTxHash != null){
            console.log("Waiting for the second transaction ("+spentTxHash+") to be confirmed...")
            let spentTxExists = await nodeConnector.waitForTx(spentTxHash, 60000)
        }

        // Wait for the utxo-tracker to show confirmed UTXOs from tx1.
        // We always use txHash (tx1) because it has the change output back to our address.
        // For P2SH, tx2 (the spending tx) has no change output, so its txid would never
        // appear as a UTXO for this address.
        // We filter to confirmations > 0 so stale mempool entries (which can persist
        // for up to 60 s until the tracker's mempoolDb cleanup cycle) are ignored.
        console.log("Waiting for the utxo-tracker to index confirmed UTXOs from tx "+txHash+"...")
        const trackerEnd = Date.now() + 20000
        while (Date.now() < trackerEnd) {
            try {
                let result = await utxoTrackerConnector.getUtxosFromAddress(addressInfo["address"])
                let utxos = result["utxos"] || []
                let confirmedUtxos = utxos.filter(u => u.confirmations > 0)
                if (confirmedUtxos.some(u => u.txid === txHash)) {
                    transactionState.verifiedUtxos = confirmedUtxos
                    transactionState.verifiedUtxosAddress = addressInfo["address"]
                    break
                }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 500))
        }
        if (!transactionState.verifiedUtxos) {
            // Timed out; save whatever confirmed UTXOs are available as a best-effort fallback
            try {
                let result = await utxoTrackerConnector.getUtxosFromAddress(addressInfo["address"])
                let utxos = result["utxos"] || []
                transactionState.verifiedUtxos = utxos.filter(u => u.confirmations > 0)
                transactionState.verifiedUtxosAddress = addressInfo["address"]
            } catch (e) {}
        }

        return spentTxHash != null ? spentTxHash : txHash

    }
}
