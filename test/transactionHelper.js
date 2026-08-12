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
const CryptoNetworks = require('../src/CryptoNetworks')

// Taproot needs the ECC backend registered before any p2tr payment is built or
// any script-path input is finalized; without it bitcoinjs-lib throws
// "ecc library invalid" from inside finalizeAllInputs on the envelope reveal.
bitcoin.initEccLib(ecc)

const TEST_FEE = 5460

// Verified confirmed UTXOs from the last tx wait loop, keyed by address.
// Passed directly to the encoder on the next call to bypass the tracker fetch,
// preventing stale mempool-db outputs from being picked up.
let _verifiedUtxos = null
let _verifiedUtxosAddress = null

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

function _isStaleUtxoError(err){
    const msg = (err && err.message) || ''
    // `missingorspent`/`bad-txns-inputs`: node rejected because inputs were already spent.
    // `Missing inputs`: bitcoin/dogecoin's bare RPC error -25 message for the same condition
    //   (kept as a distinct pattern because the JSON-RPC layer can deliver either form).
    // `no utxos ... no utxos found`: encoder asked the tracker for UTXOs but the tracker
    //   hadn't yet indexed the change output from the source's previous tx.
    // `Cannot read propert(y|ies)... 'txid'`: encoder threw a TypeError when sorting an
    //   empty UTXO list (utxos[0]["txid"]). Happens when `unconfirmed=false` filters out
    //   all the tracker's UTXOs because the source's funding tx is still in mempool. Retry
    //   succeeds after quiesce mines a block and the funding confirms. The encoder ought
    //   to throw "no utxos" post-filter; this pattern is a defensive shim until that lands.
    // `Internal encoder error`: the encoder sanitizes non-TypeError/RangeError messages
    //   to this generic string before returning over JSON-RPC. In practice on the regtest
    //   stack this is almost always the "no utxos" case caught above (visible in the
    //   encoder's own console.error log). Retrying is safe even if the cause turns out
    //   to be something else, since we'd hit the same error again and surface it.
    return /missingorspent|missing\s*or\s*spent|missing\s+inputs|bad-txns-inputs|no utxos.*no utxos|Cannot read propert(y|ies).*['"]?txid['"]?|Internal encoder error/i.test(msg)
}

module.exports = {
    // Wrap the build+sign+broadcast in a small retry loop. The encoder may pull
    // UTXOs from the utxo-tracker during an indexing-lag window, build a tx that
    // references inputs the bitcoind has already spent, and broadcast would die
    // with `bad-txns-inputs-missingorspent`. Drop the cache and wait briefly so
    // the tracker can catch up, then rebuild from scratch.
    // `opts` (all optional):
    //   compress  tri-state passed straight through to the encoder (null = its default)
    //   capture   an object this helper fills in with the encoder's build metadata
    //             (encoding, compression report, envelope recovery record, commit and
    //             reveal txids). Tests that assert on HOW the action was carried need
    //             it, because the return value is only ever the action's txid.
    async createAndSendTransaction(addressInfo, data, rawData = null, customOutputs = [], outputType = null, compressedPubKey = null, skipNativeFeeInjection = false, opts = {}){
        // Native-coin fee injection for LTC/DOGE (no-op on BTC). The general
        // action builder is gas-mode, but LTC/DOGE reject a fee-bearing action
        // that carries no native fee output. Inject the fee output ONCE here,
        // outside the retry loop (fee sizing doesn't change across stale-UTXO
        // rebuilds). Skip when the caller opts out (a test deliberately omitting
        // the fee) or already supplied a FEE_DESTINATION output of its own
        // (nativeFeeLive/nativeFeeDispenser pass theirs).
        let outputs = Array.isArray(customOutputs) ? customOutputs : []
        if (!skipNativeFeeInjection) {
            // getNativeFeeOutput() discovers the stack's real fee mode (env or
            // the indexer feeschedule): returns null on gas-mode chains (BTC),
            // an output on native-fee chains (LTC/DOGE), or THROWS on a fee chain
            // it can't resolve. Let that throw propagate; a silent skip here is
            // exactly what hung the LTC/DOGE suite. Dedup against the discovered
            // destination so callers that supply their own fee output (e.g.
            // nativeFeeLive/nativeFeeDispenser) aren't double-charged.
            const nativeFeeHelper = require('./helpers/nativeFeeHelper')
            const feeOutput = await nativeFeeHelper.getNativeFeeOutput()
            if (feeOutput) {
                const alreadyHasFee = outputs.some(o => o && o.address === feeOutput.address)
                if (!alreadyHasFee) {
                    outputs = [feeOutput, ...outputs]
                    console.log('nativeFeeHelper: injected native fee output ' + feeOutput.value + ' sats -> ' + feeOutput.address)
                }
            }
        }

        // 15 attempts gives generous budget under full-suite load. Session 4
        // settled on 8; one stubborn ORDER partial-fill failure burned all 8
        // with identical rebuilds, suggesting the tracker had a phantom UTXO
        // that didn't clear within an 80s window. Per-retry wait is handled by
        // quiesce() (active wait for ready=true) at 20s timeout per attempt.
        const MAX_ATTEMPTS = 15
        let lastErr
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                return await this._doCreateAndSendTransaction(addressInfo, data, rawData, outputs, outputType, compressedPubKey, opts)
            } catch (err) {
                if (attempt < MAX_ATTEMPTS && _isStaleUtxoError(err)) {
                    // TRAP LOG: capture tracker's view of this address at the
                    // moment of failure. The encoder picks utxos[0] (sorted by
                    // value desc), so the first entry is what got rejected.
                    // Cross-check against bitcoind's gettxout to identify
                    // phantoms next time the bug surfaces under load.
                    try {
                        const addr = addressInfo && addressInfo["address"]
                        if (addr) {
                            const snap = await utxoTrackerConnector.getUtxosFromAddress(addr)
                            const utxos = (snap && snap["utxos"]) || []
                            const sorted = utxos.slice().sort((a,b) => Number(b.value) - Number(a.value))
                            console.log("STALE-UTXO TRAP [" + addr + "] tracker reports " + utxos.length + " UTXO(s):")
                            for (let i = 0; i < sorted.length; i++) {
                                const u = sorted[i]
                                console.log("  [" + i + "] " + u.txid + ":" + u.vout + " value=" + u.value + " conf=" + u.confirmations + (i === 0 ? "  <- encoder picked this" : ""))
                            }
                        }
                    } catch (e) { /* trap log is best-effort */ }
                    _verifiedUtxos = null
                    _verifiedUtxosAddress = null
                    console.log("Broadcast failed (attempt " + attempt + "/" + MAX_ATTEMPTS + ") with stale UTXO; quiescing stack before retry...")
                    // Active wait for the regtest stack to fully settle (mempool
                    // empty, tracker committed-height == node height) instead of
                    // a blind sleep. quiesce() itself mines a block when mempool
                    // is non-empty, so straggling broadcasts get confirmed before
                    // we re-ask the encoder for UTXOs.
                    try {
                        await utxoTrackerConnector.quiesce({ timeoutMs: 20000, pollMs: 250, regtestMiner: regtestMinerConnector })
                    } catch (e) { /* swallow; next retry surfaces any persistent issue */ }
                    lastErr = err
                    continue
                }
                throw err
            }
        }
        throw lastErr
    },

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

    async _doCreateAndSendTransaction(addressInfo, data, rawData = null, customOutputs = [], outputType = null, compressedPubKey = null, opts = {}){
        console.log("Creating the transaction...")
        const utxoListForEncoder = (_verifiedUtxosAddress === addressInfo["address"] && _verifiedUtxos) ? _verifiedUtxos : []
        _verifiedUtxos = null
        _verifiedUtxosAddress = null
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
                    _verifiedUtxos = confirmedUtxos
                    _verifiedUtxosAddress = addressInfo["address"]
                    break
                }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 500))
        }
        if (!_verifiedUtxos) {
            // Timed out; save whatever confirmed UTXOs are available as a best-effort fallback
            try {
                let result = await utxoTrackerConnector.getUtxosFromAddress(addressInfo["address"])
                let utxos = result["utxos"] || []
                _verifiedUtxos = utxos.filter(u => u.confirmations > 0)
                _verifiedUtxosAddress = addressInfo["address"]
            } catch (e) {}
        }

        return spentTxHash != null ? spentTxHash : txHash

    },
    
    isSegwitUTXO(utxo) {
        try {
            const script = bitcoin.script.decompile(Buffer.from(utxo.scriptPubKey, 'hex'));
            
            return script[0] === 0x00;
        } catch (error) {
            return false;
        }
    },
    
    async createSimpleTransaction(addressInfo, destinationAddress, amount){
        if (_verifiedUtxosAddress === addressInfo["address"]) {
            _verifiedUtxos = null
            _verifiedUtxosAddress = null
        }
        let psbt = new bitcoin.Psbt({ network: NETWORK_OBJECT })
        let feePerBytes = await nodeConnector.getFeePerKilobyte(1)/1000
        
        let utxoSequence = 0xffffffff
        let inputSatoshis = 0

        utxosList = await utxoTrackerConnector.getUtxosFromAddress(addressInfo["address"])
        utxosList = utxosList["utxos"]
        
        if ((utxosList == null) || (utxosList.length == 0)){
            throw new Error("couldn't find any utxos for address "+addressInfo["address"])
        }
        
        let utxoIndex = 0
        while (utxoIndex < utxosList.length){
            let nextUtxo = utxosList[utxoIndex]
            
            let utxoDupIndex = utxoIndex + 1
            while (utxoDupIndex < utxosList.length){
                let nextUtxoDup = utxosList[utxoDupIndex]
                
                if ((nextUtxoDup.txid == nextUtxo.txid) && (nextUtxoDup.vout == nextUtxo.vout)){
                    utxosList.splice(utxoDupIndex, 1)
                } else {
                    utxoDupIndex = utxoDupIndex + 1
                }
            }
            
            utxoIndex = utxoIndex+1
        }

        utxosList.sort((a,b)=> b.value - a.value)
        
        let estimatedFee = NETWORK_OBJECT.dustThreshold
        
        let nextUtxoIndex = 0
        while (nextUtxoIndex < utxosList.length){
            let nextUtxo = utxosList[nextUtxoIndex]
            nextUtxo.value = parseInt(nextUtxo.value)
            
            if (this.isSegwitUTXO(nextUtxo)){
                let nextInput = {
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
                let wholeUtxoHex = await nodeConnector.getTransactionHex(nextUtxo.txid)
                let nextInput = {
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
        
        let changeSatoshis = inputSatoshis - amount - estimatedFee
        
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
        
        var ECPair = ECPairFactory(ecc);
        let keyToSign = ECPair.fromPrivateKey(addressInfo["privateKey"], { NETWORK_OBJECT });

        for (let proxInputIndex in psbt.data.inputs){
            let proxInput = psbt.data.inputs[proxInputIndex]            
            psbt.signInput(parseInt(proxInputIndex), keyToSign);
        }
        
        psbt.finalizeAllInputs();
        psbt.setMaximumFeeRate(100000)
        let tx = psbt.extractTransaction()
        let txHash = tx.getId()
        let txHex = tx.toHex()
        
        console.log("Sending a simple transaction... (hex length: "+txHex.length+")")
        txHash = await nodeConnector.broadcastTx(txHex)
        console.log("Waiting for the simple transaction ("+txHash+") to be confirmed...")
        let txExists = await nodeConnector.waitForTx(txHash, 60000)

        // Wait for confirmed UTXOs only; ignore stale mempool entries.
        console.log("Waiting for the utxo-tracker to index confirmed UTXOs from simple tx "+txHash+"...")
        const trackerEnd2 = Date.now() + 20000
        while (Date.now() < trackerEnd2) {
            try {
                let result = await utxoTrackerConnector.getUtxosFromAddress(addressInfo["address"])
                let utxos = result["utxos"] || []
                let confirmedUtxos = utxos.filter(u => u.confirmations > 0)
                if (confirmedUtxos.some(u => u.txid === txHash)) {
                    _verifiedUtxos = confirmedUtxos
                    _verifiedUtxosAddress = addressInfo["address"]
                    break
                }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 500))
        }
        if (!_verifiedUtxos) {
            try {
                let result = await utxoTrackerConnector.getUtxosFromAddress(addressInfo["address"])
                let utxos = result["utxos"] || []
                _verifiedUtxos = utxos.filter(u => u.confirmations > 0)
                _verifiedUtxosAddress = addressInfo["address"]
            } catch (e) {}
        }

        return txHash
    }
}

