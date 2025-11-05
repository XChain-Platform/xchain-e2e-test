const cryptoHelper = require('./cryptoHelper')
const transactionHelper = require('./transactionHelper')
const xchainMessageHelper = require('./xchainMessageHelper')
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
    it('should create Issue Messages v0', async () => {
        console.log("Creating new address for testing issues v0 format")
        let issueAddress = await cryptoHelper.getNewFundedAddress("ISSUE.V0", COIN, NETWORK, null, "legacy", 0, 1)
        let newAddress = issueAddress["address"]
                
        await xchainMessageHelper.sendIssueV0(
            issueAddress,
            "TESTV0"+newAddress.substring(newAddress.length-8), 
            100, 
            2, 
            0, 
            "Issuance v0 test", 
            10, 
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            ''
        )
        
        await xchainMessageHelper.sendIssueV0(
            issueAddress,
            "TESTV2"+newAddress.substring(newAddress.length-8), 
            100, 
            5, 
            0, 
            "2nd Issuance v0 test", 
            20, 
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            ''
        )
    }); 
    it('should create an Issue Message v1', async () => {
        console.log("Creating new address for testing issues v1 format")
        let issueAddress = await cryptoHelper.getNewFundedAddress("ISSUE.V1", COIN, NETWORK, null, "legacy", 0, 1) //Obtain a new address to issue some tick
        let newAddress = issueAddress["address"]
                
        await xchainMessageHelper.sendIssueV1(
            issueAddress,
            "TEST"+newAddress.substring(newAddress.length-8), 
            "Ticker issuance TEST"
        )
    });
    it('should create a MINT v0', async () => {
        console.log("Creating new address for testing MINTs v0 format")
        let mintAddress = await cryptoHelper.getNewFundedAddress("MINT.V0", COIN, NETWORK, null, "legacy", 0, 1) //Obtain a new address to issue some tick
        let issueV0Wallet = await cryptoHelper.getWallet("ISSUE.V0")
        let issueV0WalletAddress = issueV0Wallet.addresses[0]
                
        await xchainMessageHelper.sendMintV0(
            issueV0WalletAddress,
            "TESTV0"+issueV0WalletAddress["address"].substring(issueV0WalletAddress["address"].length-8),
            2,
            mintAddress["address"],
            "A simple MINT test v0"
        )
    });
    it('should create a SEND Message v0', async () => {
        console.log("Creating new address for the test")
        let sendAddress = await cryptoHelper.getNewAddress("SEND.V0", COIN, NETWORK, null, "legacy") //Obtain a new address to send some tick
        let issueV0Wallet = await cryptoHelper.getWallet("ISSUE.V0")
        let issueV0WalletAddress = issueV0Wallet.addresses[0]
        
        await xchainMessageHelper.sendSendV0(
            issueV0WalletAddress,
            "TESTV0"+issueV0WalletAddress["address"].substring(issueV0WalletAddress["address"].length-8), 
            1,
            sendAddress["address"],
            "A simple SEND test v0"
        )
    });
    it('should create a SEND Message v1', async () => {
        console.log("Creating new address for the test")
        let sendAddress1 = await cryptoHelper.getNewAddress("SEND.V1", COIN, NETWORK, null, "legacy", 0) //Obtain a new address to send some tick
        let sendAddress2 = await cryptoHelper.getNewAddress("SEND.V1", COIN, NETWORK, null, "legacy", 1) //Obtain a second new address to send some tick
        let issueV0Wallet = await cryptoHelper.getWallet("ISSUE.V0")
        let issueV0WalletAddress = issueV0Wallet.addresses[0]
        
        console.log("Sending tokens from "+issueV0WalletAddress["address"]+" to "+sendAddress1["address"]+" and to "+sendAddress2["address"])
        let command = "SEND"
        let sendVersion = 1
        let tick = "TESTV0"+issueV0WalletAddress["address"].substring(issueV0WalletAddress["address"].length-8)
        let amount1 = 1
        let destination1 = sendAddress1["address"]
        let amount2 = 1
        let destination2 = sendAddress2["address"]
        let memo = "A simple SEND test v1"
        
        await xchainMessageHelper.sendSendV1(
            issueV0WalletAddress,
            "TESTV0"+issueV0WalletAddress["address"].substring(issueV0WalletAddress["address"].length-8), 
            1,
            sendAddress1["address"],
            2,
            sendAddress2["address"],
            "A simple SEND test v1"
        )
    });
    it('should create a SEND Message v2', async () => {
        console.log("Creating new address for the test")
        let sendAddress1 = await cryptoHelper.getNewAddress("SEND.V2", COIN, NETWORK, null, "legacy", 0) //Obtain a new address to send some tick
        let sendAddress2 = await cryptoHelper.getNewAddress("SEND.V2", COIN, NETWORK, null, "legacy", 1) //Obtain a second new address to send some tick
        let issueV0Wallet = await cryptoHelper.getWallet("ISSUE.V0")
        let issueV0WalletAddress = issueV0Wallet.addresses[0]
        
        await xchainMessageHelper.sendSendV2(
            issueV0WalletAddress,
            "TESTV0"+issueV0WalletAddress["address"].substring(issueV0WalletAddress["address"].length-8), 
            1,
            sendAddress1["address"],
            "TESTV2"+issueV0WalletAddress["address"].substring(issueV0WalletAddress["address"].length-8), 
            2,
            sendAddress2["address"],
            "A simple SEND test v2"
        )
    });
    it('should create a SEND Message v3', async () => {
        console.log("Creating new address for the test")
        let sendAddress1 = await cryptoHelper.getNewAddress("SEND.V3", COIN, NETWORK, null, "legacy", 0) //Obtain a new address to send some tick
        let sendAddress2 = await cryptoHelper.getNewAddress("SEND.V3", COIN, NETWORK, null, "legacy", 1) //Obtain a second new address to send some tick
        let issueV0Wallet = await cryptoHelper.getWallet("ISSUE.V0")
        let issueV0WalletAddress = issueV0Wallet.addresses[0]
        
        await xchainMessageHelper.sendSendV3(
            issueV0WalletAddress,
            "TESTV0"+issueV0WalletAddress["address"].substring(issueV0WalletAddress["address"].length-8), 
            1,
            sendAddress1["address"],
            "1st SEND test v3",
            "TESTV2"+issueV0WalletAddress["address"].substring(issueV0WalletAddress["address"].length-8), 
            2,
            sendAddress2["address"],
            "2nd SEND test v3"
        )
    });
    it('should create a BROADCAST Message v0', async () => {
        console.log("Creating new address for the test")
        let broadcastAddress = await cryptoHelper.getNewFundedAddress("BROADCAST.V0", COIN, NETWORK, null, "legacy",0,1) 
        
        await xchainMessageHelper.sendBroadcastV0(
            broadcastAddress,
            "A simple BROADCAST test v0", 
            1
        )
    });
    it('should create a BROADCAST Message v1', async () => {
        console.log("Creating new address for the test")
        let broadcastAddress = await cryptoHelper.getNewFundedAddress("BROADCAST.V1", COIN, NETWORK, null, "legacy",0,1) 
        
        await xchainMessageHelper.sendBroadcastV1(
            broadcastAddress,
            "A simple BROADCAST test v1", 
            1,
            0.01,
            "Memo test for BROADCAST v1"
        )
    });
    it('should create a BROADCAST Message v2', async () => {
        console.log("Creating new address for the test")
        let broadcastAddress = await cryptoHelper.getNewFundedAddress("BROADCAST.V2", COIN, NETWORK, null, "legacy",0,1) 
        
        await xchainMessageHelper.sendBroadcastV2(
            broadcastAddress,
            "A simple BROADCAST test v2", 
            0.01,
            "Memo test for BROADCAST v2"
        )
    });
    it('should create a BROADCAST Message v3', async () => {
        console.log("Creating new address for the test")
        let broadcastAddress = await cryptoHelper.getNewFundedAddress("BROADCAST.V3", COIN, NETWORK, null, "legacy",0,1) 
        
        await xchainMessageHelper.sendBroadcastV3(
            broadcastAddress,
            1, //TODO: this test won't work if there isn't at least one action in the db
            0.01,
            "Memo test for BROADCAST v3"
        )
    });
    it('should create a LIST Message v0 with tickers', async () => {
        let issueV0Wallet = await cryptoHelper.getWallet("ISSUE.V0")
        let issueV0WalletAddress = issueV0Wallet.addresses[0]
        console.log("Creating new address for the test")
        let listAddress = await cryptoHelper.getNewFundedAddress("LIST.V0.TICKERS", COIN, NETWORK, null, "legacy",0,1) 
        
        await xchainMessageHelper.sendListV0(
            listAddress,
            1, //type 1=TICKERS
            [
                "TESTV0"+issueV0WalletAddress["address"].substring(issueV0WalletAddress["address"].length-8),
                "TESTV2"+issueV0WalletAddress["address"].substring(issueV0WalletAddress["address"].length-8)
            ]
        )
    });
    it('should create a LIST Message v0 with addresses', async () => {
        console.log("Creating new addresses for the test")
        let listAddress0 = await cryptoHelper.getNewFundedAddress("LIST.V0", COIN, NETWORK, null, "legacy",0,1) 
        let listAddress1 = await cryptoHelper.getNewAddress("LIST.V0", COIN, NETWORK, null, "legacy",1) 
        let listAddress2 = await cryptoHelper.getNewAddress("LIST.V0", COIN, NETWORK, null, "legacy",2) 
        let listAddress3 = await cryptoHelper.getNewAddress("LIST.V0", COIN, NETWORK, null, "legacy",3) 
        
        await xchainMessageHelper.sendListV0(
            listAddress0,
            2, //type 2=ADDRESS
            [
                listAddress1["address"],
                listAddress2["address"],
                listAddress3["address"],
            ]
        )
    });
    
})
