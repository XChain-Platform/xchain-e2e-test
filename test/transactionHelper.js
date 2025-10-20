const ecc = require('tiny-secp256k1')
const bitcoin = require('bitcoinjs-lib')
const {ECPairFactory} = require('ecpair')
const psbtutils = require('bitcoinjs-lib/src/psbt/psbtutils')

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
        
        let encodeType = txPsbtHex["encode_type"]
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
            return spentTxHash
        } else {
            return txHash   
        }
        
    }
}

