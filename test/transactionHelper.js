const ecc = require('tiny-secp256k1')
const bitcoin = require('bitcoinjs-lib')
const {ECPairFactory} = require('ecpair')
const psbtutils = require('bitcoinjs-lib/src/psbt/psbtutils')
const CryptoNetworks = require('../src/CryptoNetworks')

const TEST_FEE = 5460

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
    async createAndSendTransaction(addressInfo, data){
        console.log("Creating the transaction...")
        let txPsbtHex = await encoderConnector.createTx(
            [], //utxoList - the encoder will find the utxos
            addressInfo["address"], //pubkey
            [], //customOutputs - None
            data,
            null, //rawData
            null, //TEST_FEE, //exact_fee
            false, //rbf - false, it's not needed for this test
            null, //outputType - the encoder will automatically determine which output type to use 
            addressInfo["address"], //changeAddress - the bitcoins will return to the same address
            null, 
            null, 
            null
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
                null, //rawData
                null, //TEST_FEE, //exact_fee
                false, //rbf - false, it's not needed for this test
                null, //outputType - the encoder will automatically determine which output type to use 
                addressInfo["address"], //changeAddress - the bitcoins will return to the same address
                txHash, 
                txHex, 
                null
            )           
            
            spentTxPsbtHex = spentTxPsbtHex["psbt"]
            
            let spentPsbtToSign = bitcoin.Psbt.fromHex(spentTxPsbtHex)
            
            for (let proxInputIndex in spentPsbtToSign.data.inputs){
                let proxInput = spentPsbtToSign.data.inputs[proxInputIndex]            
                spentPsbtToSign.signInput(parseInt(proxInputIndex), keyToSign);
            }
            
            spentPsbtToSign.finalizeInput(0,xchainP2shFinalizer);
            spentTx = spentPsbtToSign.extractTransaction()
            spentHex = spentTx.toHex()
        }
        
        //let txHex = tx.toHex()
        console.log("Sending the transaction...")
        console.log(txHex)
        txHash = await nodeConnector.broadcastTx(txHex)
        let spentTxHash = null
        
        if (spentHex != null){
            console.log("Sending the second transaction...")
            console.log(spentHex)
            spentTxHash = await nodeConnector.broadcastTx(spentHex)
        }
        //wait for the transaction to be confirmed
        console.log("Waiting for the transaction ("+txHash+") to be confirmed...")
        let txExists = await nodeConnector.waitForTx(txHash, 60000)

        if (spentTxHash != null){
            console.log("Waiting for the second transaction ("+spentTxHash+") to be confirmed...")
            let spentTxExists = await nodeConnector.waitForTx(spentTxHash, 60000)
        }

        // Wait for the utxo-tracker to reflect the change UTXO from txHash so the next
        // encoder call does not pick up already-spent inputs.
        console.log("Waiting for the utxo-tracker to index the change UTXO from tx "+txHash+"...")
        const trackerEnd = Date.now() + 30000
        while (Date.now() < trackerEnd) {
            try {
                let result = await utxoTrackerConnector.getUtxosFromAddress(addressInfo["address"])
                let utxos = result["utxos"] || []
                if (utxos.some(u => u.txid === txHash)) break
            } catch (e) {}
            await new Promise(r => setTimeout(r, 500))
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
        let tx = psbt.extractTransaction()
        let txHash = tx.getId()
        let txHex = tx.toHex()
        
        //let txHex = tx.toHex()
        console.log("Sending a simple transaction...")
        console.log(txHex)
        txHash = await nodeConnector.broadcastTx(txHex)
        //wait for the transaction to be confirmed
        console.log("Waiting for the simple transaction ("+txHash+") to be confirmed...")
        let txExists = await nodeConnector.waitForTx(txHash, 60000)
        
        return txHash   
    }
}

