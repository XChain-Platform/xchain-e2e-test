const ecc = require('tiny-secp256k1')
const bitcoin = require('bitcoinjs-lib')
const {ECPairFactory} = require('ecpair')
const psbtutils = require('bitcoinjs-lib/src/psbt/psbtutils')
const CryptoNetworks = require('../src/CryptoNetworks')

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
    // `missingorspent`/`bad-txns-inputs` — node rejected because inputs were already spent.
    // `Missing inputs` — bitcoin/dogecoin's bare RPC error -25 message for the same condition
    //   (kept as a distinct pattern because the JSON-RPC layer can deliver either form).
    // `no utxos ... no utxos found` — encoder asked the tracker for UTXOs but the tracker
    //   hadn't yet indexed the change output from the source's previous tx. Also covers
    //   the `unconfirmed=false`-stripped-everything case (encoder throws the same message
    //   from the post-filter empty check).
    // `Internal encoder error` — the encoder sanitizes non-TypeError/RangeError messages
    //   to this generic string before returning over JSON-RPC. In practice on the regtest
    //   stack this is almost always the "no utxos" case caught above (visible in the
    //   encoder's own console.error log). Retrying is safe even if the cause turns out
    //   to be something else, since we'd hit the same error again and surface it.
    return /missingorspent|missing\s*or\s*spent|missing\s+inputs|bad-txns-inputs|no utxos.*no utxos|Internal encoder error/i.test(msg)
}

module.exports = {
    // Wrap the build+sign+broadcast in a small retry loop. The encoder may pull
    // UTXOs from the utxo-tracker during an indexing-lag window, build a tx that
    // references inputs the bitcoind has already spent, and broadcast would die
    // with `bad-txns-inputs-missingorspent`. Drop the cache and wait briefly so
    // the tracker can catch up, then rebuild from scratch.
    async createAndSendTransaction(addressInfo, data, rawData = null, customOutputs = [], outputType = null){
        // 15 attempts gives generous budget under full-suite load. Session 4
        // settled on 8; one stubborn ORDER partial-fill failure burned all 8
        // with identical rebuilds, suggesting the tracker had a phantom UTXO
        // that didn't clear within an 80s window. Per-retry wait is handled by
        // quiesce() (active wait for ready=true) at 20s timeout per attempt.
        const MAX_ATTEMPTS = 15
        let lastErr
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                return await this._doCreateAndSendTransaction(addressInfo, data, rawData, customOutputs, outputType)
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
                    console.log("Broadcast failed (attempt " + attempt + "/" + MAX_ATTEMPTS + ") with stale UTXO — quiescing stack before retry...")
                    // Active wait for the regtest stack to fully settle (mempool
                    // empty, tracker committed-height == node height) instead of
                    // a blind sleep. quiesce() itself mines a block when mempool
                    // is non-empty, so straggling broadcasts get confirmed before
                    // we re-ask the encoder for UTXOs.
                    try {
                        await utxoTrackerConnector.quiesce({ timeoutMs: 20000, pollMs: 250, regtestMiner: regtestMinerConnector })
                    } catch (e) { /* swallow — next retry surfaces any persistent issue */ }
                    lastErr = err
                    continue
                }
                throw err
            }
        }
        throw lastErr
    },

    async _doCreateAndSendTransaction(addressInfo, data, rawData = null, customOutputs = [], outputType = null){
        console.log("Creating the transaction...")
        const utxoListForEncoder = (_verifiedUtxosAddress === addressInfo["address"] && _verifiedUtxos) ? _verifiedUtxos : []
        _verifiedUtxos = null
        _verifiedUtxosAddress = null
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
            null,
            null,
            null,
            // unconfirmed=false: e2e test traffic always waits for confirmation
            // before issuing the next tx, so we should never need to spend a
            // mempool UTXO. Filtering them out at the encoder defends against
            // the tracker's mempool DB carrying stale entries (a node-side
            // dropped tx that the tracker's 60s mempool poll hasn't yet
            // reconciled — see STALE-UTXO TRAP log).
            false
        )
        
        let encodeType = txPsbtHex["encoding"]
        txPsbtHex = txPsbtHex["psbt"]
        
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
        if (encodeType == "P2SH"){
            console.log("Creating the second transaction (the encode type P2SH was chosen)...")
            let spentTxPsbtHex = await encoderConnector.createTx(
                [], //utxoList - the encoder will find the utxos
                addressInfo["address"], //pubkey
                [], //customOutputs - None
                data,
                rawData, //rawData
                null, //TEST_FEE, //exact_fee
                false, //rbf - false, it's not needed for this test
                outputType, //outputType - propagate the caller's choice (null = auto, "P2SH" = forced)
                addressInfo["address"], //changeAddress - the bitcoins will return to the same address
                txHash,
                txHex,
                null,
                false  // unconfirmed=false — see comment above
            )
            
            spentTxPsbtHex = spentTxPsbtHex["psbt"]
            
            let spentPsbtToSign = bitcoin.Psbt.fromHex(spentTxPsbtHex)
            
            for (let proxInputIndex in spentPsbtToSign.data.inputs){
                let proxInput = spentPsbtToSign.data.inputs[proxInputIndex]            
                spentPsbtToSign.signInput(parseInt(proxInputIndex), keyToSign);
            }
            
            // Every input in the spent tx carries an XChain P2SH-encoded
            // payload chunk (large action data like DEPLOY code is split
            // across multiple P2SH inputs by the encoder). All of them
            // need the custom finalizer.
            for (let i = 0; i < spentPsbtToSign.data.inputs.length; i++) {
                spentPsbtToSign.finalizeInput(i, xchainP2shFinalizer);
            }
            spentPsbtToSign.setMaximumFeeRate(100000)
            spentTx = spentPsbtToSign.extractTransaction()
            spentHex = spentTx.toHex()
        }
        
        //let txHex = tx.toHex()
        console.log("Sending the transaction... (hex length: "+txHex.length+")")
        txHash = await nodeConnector.broadcastTx(txHex)
        let spentTxHash = null
        
        if (spentHex != null){
            console.log("Sending the second transaction... (hex length: "+spentHex.length+")")
            spentTxHash = await nodeConnector.broadcastTx(spentHex)
        }
        //wait for the transaction to be confirmed
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
            // Timed out — save whatever confirmed UTXOs are available as a best-effort fallback
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
        
        //Remove duplicated utxos
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

        //Order the utxosList from the biggest value to the smallest
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
        
        //
        //SIGNING THE TRANSACTION
        //
        
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
        
        //let txHex = tx.toHex()
        console.log("Sending a simple transaction... (hex length: "+txHex.length+")")
        txHash = await nodeConnector.broadcastTx(txHex)
        //wait for the transaction to be confirmed
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

