const axios = require('axios');
const crypto = require('crypto');
const bip39 = require('bip39');
const ecc = require('tiny-secp256k1')
const { BIP32Factory } = require('bip32')
const bip32 = BIP32Factory(ecc)
const bitcoin = require('bitcoinjs-lib')
const CryptoNetworks = require('../src/CryptoNetworks')
const transactionHelper = require('./transactionHelper')
const assert = require('assert')

const rpcUser = 'rpc';
const rpcPassword = 'rpc';
const url = 'http://localhost:8333';        

global.wallets = {}

module.exports = {
    async sendIssueV0(addressInfo, tick, maxSupply, maxMint, decimals, description, mintSupply, 
        transfer='', transferSupply='', lockMaxSupply='', lockMaxMint='', lockDescription='', lockRug='',
        lockSleep='', lockCallback='', callbackBlock='', callbackTick='', callbackAmount='', 
        allowList='', blockList='', mintAddressMax='', mintStartBlock='', mintStopBlock='', lockMint='',
        lockMintSupply=''
    ){
        let address = addressInfo["address"]
    
        let command = "ISSUE"
        let issueVersion = 0
        
        let issueMessage = command
            +"|"+issueVersion+"|"+tick+"|"+maxSupply
            +"|"+maxMint+"|"+decimals+"|"+description+"|"+mintSupply
            +"|"+transfer+"|"+transferSupply+"|"+lockMaxSupply+"|"+lockMaxMint
            +"|"+lockDescription+"|"+lockRug+"|"+lockSleep+"|"+lockCallback
            +"|"+callbackBlock+"|"+callbackTick+"|"+callbackAmount+"|"+allowList
            +"|"+blockList+"|"+mintAddressMax+"|"+mintStartBlock+"|"+mintStopBlock
            +"|"+lockMint+"|"+lockMintSupply
    
        console.log("Creating and sending ISSUE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)
        
        console.log("Waiting for ISSUE in the database...")
        let issueExists = await indexerDatabase.waitForIssue(
            {
                source:address, 
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
        
        let creditExists = await indexerDatabase.waitForCredit(
            {
                address:address, 
                tick:tick,
                txHash:txHash,
                amount:mintSupply
            }
        )
        assert(creditExists)
    },
    
    async sendIssueV1(addressInfo, tick, description){
        let address = addressInfo["address"]
    
        let command = "ISSUE"
        let issueVersion = 1
        
        let issueMessage = command+"|"+issueVersion+"|"+tick+"|"+description
    
        console.log("Creating and sending ISSUE V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)
        
        console.log("Waiting for ISSUE in the database...")
        let issueExists = await indexerDatabase.waitForIssue(
            {
                source:address, 
                tick:tick,
                txHash:txHash,
                description:description,
                status:"valid"
            }
        )
        assert(issueExists)
    },
    
    async sendMintV0(addressInfo, tick, amount, destination, memo){
        let address = addressInfo["address"]
    
        let command = "MINT"
        let mintVersion = 0
        
        let mintMessage = command+"|"+mintVersion+"|"+tick+"|"+amount+"|"+destination+"|"+memo
    
        console.log("Creating and sending MINT V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, mintMessage)
        
        console.log("Waiting for MINT in the database...")
        let mintExists = await indexerDatabase.waitForMint(
            {
                txHash:txHash,
                tick:tick,
                destination:destination, 
                amount:amount,
                memo:memo,
                status:"valid"
            }
        )
        assert(mintExists)
        
        let creditExists = await indexerDatabase.waitForCredit(
            {
                address:destination, 
                tick:tick,
                txHash:txHash,
                amount:amount
            }
        )
        assert(creditExists)
    },
    
    async sendSendV0(addressInfo, tick, amount, destination, memo){
        let address = addressInfo["address"]
    
        let command = "SEND"
        let sendVersion = 0
        
        let sendMessage = command+"|"+sendVersion+"|"+tick+"|"+amount+"|"+destination+"|"+memo
    
        console.log("Creating and sending SEND V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sendMessage)
        
        console.log("Waiting for SEND in the database...")
        let sendExists = await indexerDatabase.waitForSend(
            {
                source:address,
                destination:destination,
                tick:tick,
                amount:amount,
                txHash:txHash,
                memo:memo,
                status:"valid"
            }
        )
        assert(sendExists)
        
        let creditExists = await indexerDatabase.waitForCredit(
            {
                address:destination, 
                tick:tick,
                txHash:txHash,
                amount:amount
            }
        )
        assert(creditExists)
        
        let debitExists = await indexerDatabase.waitForDebit(
            {
                address:address, 
                tick:tick,
                txHash:txHash,
                amount:amount
            }
        )
        assert(debitExists)
    },
    
    async sendSendV1(addressInfo, tick, amount1, destination1, amount2, destination2, memo){
        let address = addressInfo["address"]
    
        let command = "SEND"
        let sendVersion = 1
        
        let sendMessage = command+"|"+sendVersion+"|"+tick+"|"+amount1+"|"+destination1+"|"+amount2+"|"+destination2+"|"+memo
    
        console.log("Creating and sending SEND V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sendMessage)
        
        let send1Exists = await indexerDatabase.waitForSend(
            {
                source:address,
                destination:destination1,
                tick:tick,
                amount:amount1,
                txHash:txHash,
                memo:memo,
                status:"valid"
            }
        )
        assert(send1Exists)
        
        let send2Exists = await indexerDatabase.waitForSend(
            {
                source:address,
                destination:destination2,
                tick:tick,
                amount:amount2,
                txHash:txHash,
                memo:memo,
                status:"valid"
            }
        )
        assert(send2Exists)
        
        let credit1Exists = await indexerDatabase.waitForCredit(
            {
                address:destination1, 
                tick:tick,
                txHash:txHash,
                amount:amount1
            }
        )
        assert(credit1Exists)
        
        let credit2Exists = await indexerDatabase.waitForCredit(
            {
                address:destination2, 
                tick:tick,
                txHash:txHash,
                amount:amount2
            }
        )
        assert(credit2Exists)
        
        let debitExists = await indexerDatabase.waitForDebit(
            {
                address:address, 
                tick:tick,
                txHash:txHash,
                amount:amount1+amount2
            }
        )
        assert(debitExists)
    },
    
    async sendSendV2(addressInfo, tick1, amount1, destination1, tick2, amount2, destination2, memo){
        let address = addressInfo["address"]
    
        let command = "SEND"
        let sendVersion = 2
        
        let sendMessage = command+"|"+sendVersion+"|"+tick1+"|"+amount1+"|"+destination1+"|"+tick2+"|"+amount2+"|"+destination2+"|"+memo
    
        console.log("Creating and sending SEND V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sendMessage)
        
        let send1Exists = await indexerDatabase.waitForSend(
            {
                source:address,
                destination:destination1,
                tick:tick1,
                amount:amount1,
                txHash:txHash,
                memo:memo,
                status:"valid"
            }
        )
        assert(send1Exists)
        
        let send2Exists = await indexerDatabase.waitForSend(
            {
                source:address,
                destination:destination2,
                tick:tick2,
                amount:amount2,
                txHash:txHash,
                memo:memo,
                status:"valid"
            }
        )
        assert(send2Exists)
        
        let credit1Exists = await indexerDatabase.waitForCredit(
            {
                address:destination1, 
                tick:tick1,
                txHash:txHash,
                amount:amount1
            }
        )
        assert(credit1Exists)
        
        let credit2Exists = await indexerDatabase.waitForCredit(
            {
                address:destination2, 
                tick:tick2,
                txHash:txHash,
                amount:amount2
            }
        )
        assert(credit2Exists)
        
        let debit1Exists = await indexerDatabase.waitForDebit(
            {
                address:address, 
                tick:tick1,
                txHash:txHash,
                amount:amount1
            }
        )
        assert(debit1Exists)
        
        let debit2Exists = await indexerDatabase.waitForDebit(
            {
                address:address, 
                tick:tick2,
                txHash:txHash,
                amount:amount2
            }
        )
        assert(debit2Exists)
    },
    
    async sendSendV3(addressInfo, tick1, amount1, destination1, memo1, tick2, amount2, destination2, memo2){
        let address = addressInfo["address"]
    
        let command = "SEND"
        let sendVersion = 3
        
        let sendMessage = command+"|"+sendVersion+"|"+tick1+"|"+amount1+"|"+destination1+"|"+memo1+"|"+tick2+"|"+amount2+"|"+destination2+"|"+memo2
    
        console.log("Creating and sending SEND V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sendMessage)
        
        let send1Exists = await indexerDatabase.waitForSend(
            {
                source:address,
                destination:destination1,
                tick:tick1,
                amount:amount1,
                txHash:txHash,
                memo:memo1,
                status:"valid"
            }
        )
        assert(send1Exists)
        
        let send2Exists = await indexerDatabase.waitForSend(
            {
                source:address,
                destination:destination2,
                tick:tick2,
                amount:amount2,
                txHash:txHash,
                memo:memo2,
                status:"valid"
            }
        )
        assert(send2Exists)
        
        let credit1Exists = await indexerDatabase.waitForCredit(
            {
                address:destination1, 
                tick:tick1,
                txHash:txHash,
                amount:amount1
            }
        )
        assert(credit1Exists)
        
        let credit2Exists = await indexerDatabase.waitForCredit(
            {
                address:destination2, 
                tick:tick2,
                txHash:txHash,
                amount:amount2
            }
        )
        assert(credit2Exists)
        
        let debit1Exists = await indexerDatabase.waitForDebit(
            {
                address:address, 
                tick:tick1,
                txHash:txHash,
                amount:amount1
            }
        )
        assert(debit1Exists)
        
        let debit2Exists = await indexerDatabase.waitForDebit(
            {
                address:address, 
                tick:tick2,
                txHash:txHash,
                amount:amount2
            }
        )
        assert(debit2Exists)
    },
    
    async sendBroadcastV0(addressInfo, message, value){
        let address = addressInfo["address"]
    
        let command = "BROADCAST"
        let broadcastVersion = 0
        
        let broadcastMessage = command+"|"+broadcastVersion+"|"+message+"|"+value
    
        console.log("Creating and sending BROADCAST V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, broadcastMessage)
        
        let broadcastExists = await indexerDatabase.waitForBroadcast(
            {
                source:address,
                txHash:txHash,
                message:message,
                value:value,
                status:"valid"
            }
        )
        assert(broadcastExists)
    },
    
    async sendBroadcastV1(addressInfo, message, value, fee, memo){
        let address = addressInfo["address"]
    
        let command = "BROADCAST"
        let broadcastVersion = 1
        
        let broadcastMessage = command+"|"+broadcastVersion+"|"+message+"|"+value+"|"+fee+"|"+memo
    
        console.log("Creating and sending BROADCAST V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, broadcastMessage)
        
        let broadcastExists = await indexerDatabase.waitForBroadcast(
            {
                source:address,
                txHash:txHash,
                message:message,
                value:value,
                fee:fee,
                memo:memo,
                status:"valid"
            }
        )
        assert(broadcastExists)
    },
    
    async sendBroadcastV2(addressInfo, message, fee, memo){
        let address = addressInfo["address"]
    
        let command = "BROADCAST"
        let broadcastVersion = 2
        
        let broadcastMessage = command+"|"+broadcastVersion+"|"+message+"|"+fee+"|"+memo
    
        console.log("Creating and sending BROADCAST V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, broadcastMessage)
        
        let broadcastExists = await indexerDatabase.waitForBroadcast(
            {
                source:address,
                txHash:txHash,
                message:message,
                fee:fee,
                memo:memo,
                status:"valid"
            }
        )
        assert(broadcastExists)
    },
    
    async sendBroadcastV3(addressInfo, broadcastActionIndex, value, memo){
        let address = addressInfo["address"]
    
        let command = "BROADCAST"
        let broadcastVersion = 3
        
        let broadcastMessage = command+"|"+broadcastVersion+"|"+broadcastActionIndex+"|"+value+"|"+memo
    
        console.log("Creating and sending BROADCAST V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, broadcastMessage)
        
        let broadcastExists = await indexerDatabase.waitForBroadcast(
            {
                source:address,
                txHash:txHash,
                broadcastActionIndex:broadcastActionIndex,
                value:value,
                memo:memo,
                status:"valid"
            }
        )
        assert(broadcastExists)
    },
    
    async sendListV0(addressInfo, type, items){
        let address = addressInfo["address"]
    
        let command = "LIST"
        let listVersion = 0
        
        let listMessage = command+"|"+listVersion+"|"+type+"|"+items.join("|")
    
        console.log("Creating and sending LIST V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, listMessage)
        
        let listActionIndex = await indexerDatabase.waitForList(
            {
                source:address,
                txHash:txHash,
                type:type,
                status:"valid",
                items
            }
        )
        assert(listActionIndex >= 0)
        return listActionIndex
    },
    
    async sendListV1(addressInfo, edit, listActionIndex, items, finalTypeToCheck, finalItemsToCheck){
        let address = addressInfo["address"]
    
        let command = "LIST"
        let listVersion = 1
        
        let listMessage = command+"|"+listVersion+"|"+edit+"|"+listActionIndex+"|"+items.join("|")
    
        console.log("Creating and sending LIST V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, listMessage)
        
        let newListActionIndex = await indexerDatabase.waitForList(
            {
                source:address,
                txHash:txHash,
                type:finalTypeToCheck,
                status:"valid",
                items:finalItemsToCheck
            }
        )
        assert(newListActionIndex >= 0)
        return newListActionIndex
    },
    
    async sendAirdropV0(addressInfo, tick, amount, listActionIndex, memo){
        let address = addressInfo["address"]
    
        let command = "AIRDROP"
        let airdropVersion = 0
        
        let airdropMessage = command+"|"+airdropVersion+"|"+tick+"|"+amount+"|"+listActionIndex+"|"+memo
    
        console.log("Creating and sending AIRDROP V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, airdropMessage)
        
        let newAirdropActionIndex = await indexerDatabase.waitForAirdrop(
            {
                source:address,
                txHash:txHash,
                tick:tick,
                amount:amount,
                listActionIndex:listActionIndex,
                memo:memo,
                status:"valid"
            }
        )
        assert(newAirdropActionIndex >= 0)
        return newAirdropActionIndex
    },
    
    async sendAirdropV1(addressInfo, tick1, amount1, tick2, amount2, listActionIndex, memo){
        let address = addressInfo["address"]
    
        let command = "AIRDROP"
        let airdropVersion = 1
        
        let airdropMessage = command+"|"+airdropVersion+"|"+listActionIndex+"|"+tick1+"|"+amount1+"|"+tick2+"|"+amount2+"|"+memo
    
        console.log("Creating and sending AIRDROP V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, airdropMessage)
        
        let newAirdropActionIndex = await indexerDatabase.waitForAirdrop(
            {
                source:address,
                txHash:txHash,
                tick:tick1,
                amount:amount1,
                listActionIndex:listActionIndex,
                tick2:tick2,
                amount2:amount2,
                memo:memo,
                status:"valid"
            }
        )
        assert(newAirdropActionIndex >= 0)
        return newAirdropActionIndex
    },
    
    async sendAirdropV2(addressInfo, tick1, amount1, tick2, amount2, listActionIndex, listActionIndex2, memo){
        let address = addressInfo["address"]
    
        let command = "AIRDROP"
        let airdropVersion = 2
        
        let airdropMessage = command+"|"+airdropVersion+"|"+tick1+"|"+amount1+"|"+listActionIndex+"|"+tick2+"|"+amount2+"|"+listActionIndex2+"|"+memo
    
        console.log("Creating and sending AIRDROP V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, airdropMessage)
        
        let newAirdropActionIndex = await indexerDatabase.waitForAirdrop(
            {
                source:address,
                txHash:txHash,
                tick:tick1,
                amount:amount1,
                listActionIndex:listActionIndex,
                tick2:tick2,
                amount2:amount2,
                listActionIndex2:listActionIndex2,
                memo:memo,
                status:"valid"
            }
        )
        assert(newAirdropActionIndex >= 0)
        return newAirdropActionIndex
    },
    
    async sendAirdropV3(addressInfo, tick1, amount1, tick2, amount2, listActionIndex, listActionIndex2, memo, memo2){
        let address = addressInfo["address"]
    
        let command = "AIRDROP"
        let airdropVersion = 3
        
        let airdropMessage = command+"|"+airdropVersion+"|"+tick1+"|"+amount1+"|"+listActionIndex+"|"+memo+"|"+tick2+"|"+amount2+"|"+listActionIndex2+"|"+memo2
    
        console.log("Creating and sending AIRDROP V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, airdropMessage)
        
        let newAirdropActionIndex = await indexerDatabase.waitForAirdrop(
            {
                source:address,
                txHash:txHash,
                tick:tick1,
                amount:amount1,
                listActionIndex:listActionIndex,
                tick2:tick2,
                amount2:amount2,
                listActionIndex2:listActionIndex2,
                memo:memo,
                memo2:memo2,
                status:"valid"
            }
        )
        assert(newAirdropActionIndex >= 0)
        return newAirdropActionIndex
    },
    
    async sendDispenserV0(addressInfo, giveCoin, giveTick, giveAmount,
      giveEscrow, getCoin, getTick, getAmount, getAddress, fiatCode,
      fiatAmount, expiration, allowList, blockList, memo
    ){
        let address = addressInfo["address"]
    
        let command = "DISPENSER"
        let dispenserVersion = 0
        
        let dispenserMessage = command+"|"+dispenserVersion
            +"|"+giveCoin+"|"+giveTick+"|"+giveAmount+"|"+giveEscrow
            +"|"+getCoin+"|"+getTick+"|"+getAmount+"|"+getAddress
            +"|"+fiatCode+"|"+fiatAmount+"|"+expiration+"|"+allowList
            +"|"+blockList+"|"+memo
            
        console.log("Creating and sending DISPENSER V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, dispenserMessage)
        
        let newDispenserActionIndex = await indexerDatabase.waitForDispenser(
            {
                source:address,
                txHash,
                giveCoin,
                giveTick,
                giveAmount,
                giveEscrow,
                getCoin,
                getTick,
                getAmount,
                getAddress,
                fiatCode,
                fiatAmount,
                expiration,
                allowList,
                blockList,
                memo,               
                status:"valid"
            }
        )
        assert(newDispenserActionIndex >= 0)
        return newDispenserActionIndex
    }
}

