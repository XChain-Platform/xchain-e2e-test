const cryptoHelper = require('./cryptoHelper')
const transactionHelper = require('./transactionHelper')
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

const TEST_FEE = 5460 //litecoin dust limit

describe('Create Issue Messages', () => {
    it('should create a simple Issue Message v0', async () => {
        console.log("Creating new address for testing issues v0 format")
        let issueAddress = await cryptoHelper.getNewAddress("ISSUE.V0", COIN, NETWORK, null, "legacy") //Obtain a new address to issue some tick
        let newAddress = issueAddress["address"]
        let addressPublicKey = issueAddress["publicKey"]
        let addressPrivateKey = issueAddress["privateKey"]
        
        console.log("Sending funds to "+newAddress)
        let txId = await regtestMinerConnector.sendFunds(newAddress, 1)
        try {
            let txExists = await nodeConnector.waitForTx(txId)
            
            if (!txExists){
                throw new Error("The sent tx didn't appear in the blockchain")
            }           
        } catch (err){
            throw new Error("The sent tx didn't appear in the blockchain")
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
        let issueVersion = 0
        let tick = "TESTV0"+newAddress.substring(newAddress.length-8)
        let maxSupply = 10
        let maxMint = 2
        let decimals = 0
        let description = "Issuance v0 test"
        let mintSupply = 5        
        let transfer = ''
        let transferSupply = ''
        let lockMaxSupply = ''
        let lockMaxMint = ''
        let lockDescription = ''
        let lockRug = ''
        let lockSleep = ''
        let lockCallback = ''
        let callbackBlock = ''
        let callbackTick = ''
        let callbackAmount = ''
        let allowList = ''
        let blockList = ''
        let mintAddressMax = ''
        let mintStartBlock = ''
        let mintStopBlock = ''
        let lockMint = ''
        let lockMintSupply = ''
        
        let issueMessage = command
            +"|"+issueVersion+"|"+tick+"|"+maxSupply
            +"|"+maxMint+"|"+decimals+"|"+description+"|"+mintSupply
            +"|"+transfer+"|"+transferSupply+"|"+lockMaxSupply+"|"+lockMaxMint
            +"|"+lockDescription+"|"+lockRug+"|"+lockSleep+"|"+lockCallback
            +"|"+callbackBlock+"|"+callbackTick+"|"+callbackAmount+"|"+allowList
            +"|"+blockList+"|"+mintAddressMax+"|"+mintStartBlock+"|"+mintStopBlock
            +"|"+lockMint+"|"+lockMintSupply
        
        let txHash = await transactionHelper.createAndSendTransaction(issueAddress, issueMessage)
        
        console.log("Waiting for issue in the database...")
        let issueExists = await indexerDatabase.waitForIssue(
            {
                source:newAddress, 
                tick:tick,
                txHash:txHash,
                description:description,
                maxSupply:maxSupply,
                maxMint:maxMint,
                decimals:decimals, 
                mintSupply:mintSupply,
                status:"valid"
            }
        )
        
        assert(issueExists)
    });
    it('should create a simple Issue Message v1', async () => {
        console.log("Creating new address for testing issues v1 format")
        let issueAddress = await cryptoHelper.getNewAddress("ISSUE.V1", COIN, NETWORK, null, "legacy") //Obtain a new address to issue some tick
        let newAddress = issueAddress["address"]
        let addressPublicKey = issueAddress["publicKey"]
        let addressPrivateKey = issueAddress["privateKey"]
        
        console.log("Sending funds to "+newAddress)
        let txId = await regtestMinerConnector.sendFunds(newAddress, 1)
        try {
            let txExists = await nodeConnector.waitForTx(txId)
            
            if (!txExists){
                throw new Error("The sent tx didn't appear in the blockchain")
            }           
        } catch (err){
            throw new Error("The sent tx didn't appear in the blockchain")
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
        let tick = "TEST"+newAddress.substring(newAddress.length-8)
        let description = "Ticker issuance TEST"
        let issueMessage = command+"|"+issueVersion+"|"+tick+"|"+description
        
        let txHash = await transactionHelper.createAndSendTransaction(issueAddress, issueMessage)
        
        console.log("Waiting for issue in the database...")
        let issueExists = await indexerDatabase.waitForIssue(
            {
                source:newAddress, 
                tick:tick,
                txHash:txHash,
                description:description
            }
        )
        
        assert(issueExists)
    });
    it('should create a simple Send Message', async () => {
        console.log("Creating new address for the test")
        let sendAddress = await cryptoHelper.getNewAddress("SEND.V0", COIN, NETWORK, null, "legacy") //Obtain a new address to send some tick
        let issueV0Wallet = await cryptoHelper.getWallet("ISSUE.V0")
        let issueV0WalletAddress = issueV0Wallet.addresses[0]
        
        console.log("Sending tokens from "+issueV0WalletAddress["address"]+" to "+sendAddress["address"])
        let command = "SEND"
        let sendVersion = 1
        let tick = "TESTV0"+issueV0WalletAddress["address"].substring(issueV0WalletAddress["address"].length-8)
        let amount = 1
        let destination = sendAddress["address"]
        let memo = "A simple send test"
        
        let sendMessage = command+"|"+sendVersion+"|"+tick+"|"+amount+"|"+destination+"|"+memo
        
        let txHash = await transactionHelper.createAndSendTransaction(issueV0WalletAddress, sendMessage)
        
        let sendExists = await indexerDatabase.waitForSend(
            {
                source:issueV0WalletAddress["address"],
                destination:sendAddress["address"],
                tick:tick,
                amount:amount,
                txHash:txHash,
                memo:memo,
                status:"valid"
            }
        )
        
        assert(sendExists)
    })
})
