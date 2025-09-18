const cryptoHelper = require('./cryptoHelper')
const RegtestMinerConnector = require('../src/RegtestMinerConnector')
const { BIP32Factory } = require('bip32')
const ecc = require('tiny-secp256k1')
const bip32 = BIP32Factory(ecc)
const bip39 = require('bip39')
const bitcoin = require('bitcoinjs-lib')
const psbtutils = require('bitcoinjs-lib/src/psbt/psbtutils')
const crypto = require('crypto')
const {ECPairFactory} = require('ecpair')
const assert = require('assert');

const TEST_FEE = 1000

describe('Create Issue Message', () => {
    it('should create a simple Issue Message', async () => {
        console.log("Creating new address for the test")
        let issueAddress = await cryptoHelper.getNewAddress(COIN, NETWORK, null, "legacy") //Obtain a new address to send some tick
        let newAddress = issueAddress["address"]
        let addressPublicKey = issueAddress["publicKey"]
        let addressPrivateKey = issueAddress["privateKey"]
        
        console.log("Sending funds to "+newAddress)
        let txId = await regtestMinerConnector.sendFunds(newAddress, 1)
        try {
            let txExists = await nodeConnector.waitForTx(txId)
            
            if (!txExists){
                throw new Error("The send tx didn't appear in the blockchain")
            }           
        } catch (err){
            throw new Error("The send tx didn't appear in the blockchain")
        }
        console.log("Waiting for the utxos for "+newAddress)
        try {
            let addressHasUtxos = await utxoTrackerConnector.waitForUtxos(newAddress)
            
            if (!addressHasUtxos){
                throw new Error("The utxo tracker couldn't parse the utxo")
            }
        } catch (err){
            throw new Error("The utxo tracker couldn't parse the utxo")
        }
        
        let command = "ISSUE"
        let issueVersion = 1
        let tick = "TEST"+newAddress
        let description = "This is a ticker issuance TEST"
        
        let issueMessage = command+"|"+issueVersion+"|"+tick+"|"+description
        
        let issuePsbtHex = await encoderConnector.createTx(
            [], //utxoList - the encoder will find the utxos
            newAddress, //pubkey
            [], //customOutputs - None
            issueMessage, //data
            null, //rawData
            TEST_FEE, //exact_fee
            false, //rbf - false, it's not needed for this test
            null, //outputType - the encoder will automatically determine which output type to use 
            newAddress, //changeAddress - the bitcoins will return to the same address
            null, 
            null, 
            null
        )
        
        issuePsbtHex = issuePsbtHex["psbt"]
        
        let psbtToSign = bitcoin.Psbt.fromHex(issuePsbtHex)
        var ECPair = ECPairFactory(ecc);
        let keyToSign = ECPair.fromPrivateKey(addressPrivateKey, { NETWORK });

        for (let proxInputIndex in psbtToSign.data.inputs){
            let proxInput = psbtToSign.data.inputs[proxInputIndex]            
            psbtToSign.signInput(parseInt(proxInputIndex), keyToSign);
        }
        
        psbtToSign.finalizeAllInputs();
        let issueTxHex = psbtToSign.extractTransaction().toHex()
        let txHash = await nodeConnector.broadcastTx(issueTxHex)
        
        //wait for the transaction to be confirmed
        let txExists = await nodeConnector.waitForTx(txHash)
        
        let issueExists = await indexerDatabase.checkIssue()
        
        assert(issueExists)
    })
})
