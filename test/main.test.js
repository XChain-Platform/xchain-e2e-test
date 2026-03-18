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
const GAS_TICK = "XCHAIN"

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
            10
        )
        
        await xchainMessageHelper.sendIssueV0(
            issueAddress,
            "TESTV2"+newAddress.substring(newAddress.length-8), 
            100, 
            5, 
            0, 
            "2nd Issuance v0 test", 
            20
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
        let issuerAddress = await cryptoHelper.getNewFundedAddress("MINT.V0.ISSUER", COIN, NETWORK, null, "legacy", 0, 1)
        let mintDestination = await cryptoHelper.getNewAddress("MINT.V0.DEST", COIN, NETWORK, null, "legacy", 0)
        let tick = "MINTv0"+issuerAddress["address"].substring(issuerAddress["address"].length-8)

        await xchainMessageHelper.sendIssueV0(issuerAddress, tick, 100, 2, 0, "MINT test token", 10)
        await xchainMessageHelper.sendMintV0(
            issuerAddress,
            tick,
            2,
            mintDestination["address"],
            "A simple MINT test v0"
        )
    });
    it('should create a SEND Message v0', async () => {
        let senderAddress = await cryptoHelper.getNewFundedAddress("SEND.V0", COIN, NETWORK, null, "legacy", 0, 1)
        let destAddress = await cryptoHelper.getNewAddress("SEND.V0.DEST", COIN, NETWORK, null, "legacy", 0)
        let tick = "SENDv0"+senderAddress["address"].substring(senderAddress["address"].length-8)

        await xchainMessageHelper.sendIssueV0(senderAddress, tick, 100, 2, 0, "SEND v0 test token", 10)
        await xchainMessageHelper.sendSendV0(senderAddress, tick, 1, destAddress["address"], "A simple SEND test v0")
    });
    it('should create a SEND Message v1', async () => {
        let senderAddress = await cryptoHelper.getNewFundedAddress("SEND.V1", COIN, NETWORK, null, "legacy", 0, 1)
        let destAddress1 = await cryptoHelper.getNewAddress("SEND.V1.DEST1", COIN, NETWORK, null, "legacy", 0)
        let destAddress2 = await cryptoHelper.getNewAddress("SEND.V1.DEST2", COIN, NETWORK, null, "legacy", 0)
        let tick = "SENDv1"+senderAddress["address"].substring(senderAddress["address"].length-8)

        await xchainMessageHelper.sendIssueV0(senderAddress, tick, 100, 5, 0, "SEND v1 test token", 20)
        await xchainMessageHelper.sendSendV1(senderAddress, tick, 1, destAddress1["address"], 2, destAddress2["address"], "A simple SEND test v1")
    });
    it('should create a SEND Message v2', async () => {
        let senderAddress = await cryptoHelper.getNewFundedAddress("SEND.V2", COIN, NETWORK, null, "legacy", 0, 1)
        let destAddress1 = await cryptoHelper.getNewAddress("SEND.V2.DEST1", COIN, NETWORK, null, "legacy", 0)
        let destAddress2 = await cryptoHelper.getNewAddress("SEND.V2.DEST2", COIN, NETWORK, null, "legacy", 0)
        let tick1 = "SENDv2a"+senderAddress["address"].substring(senderAddress["address"].length-7)
        let tick2 = "SENDv2b"+senderAddress["address"].substring(senderAddress["address"].length-7)

        await xchainMessageHelper.sendIssueV0(senderAddress, tick1, 100, 2, 0, "SEND v2 test token 1", 10)
        await xchainMessageHelper.sendIssueV0(senderAddress, tick2, 100, 5, 0, "SEND v2 test token 2", 20)
        await xchainMessageHelper.sendSendV2(senderAddress, tick1, 1, destAddress1["address"], tick2, 2, destAddress2["address"], "A simple SEND test v2")
    });
    it('should create a SEND Message v3', async () => {
        let senderAddress = await cryptoHelper.getNewFundedAddress("SEND.V3", COIN, NETWORK, null, "legacy", 0, 1)
        let destAddress1 = await cryptoHelper.getNewAddress("SEND.V3.DEST1", COIN, NETWORK, null, "legacy", 0)
        let destAddress2 = await cryptoHelper.getNewAddress("SEND.V3.DEST2", COIN, NETWORK, null, "legacy", 0)
        let tick1 = "SENDv3a"+senderAddress["address"].substring(senderAddress["address"].length-7)
        let tick2 = "SENDv3b"+senderAddress["address"].substring(senderAddress["address"].length-7)

        await xchainMessageHelper.sendIssueV0(senderAddress, tick1, 100, 2, 0, "SEND v3 test token 1", 10)
        await xchainMessageHelper.sendIssueV0(senderAddress, tick2, 100, 5, 0, "SEND v3 test token 2", 20)
        await xchainMessageHelper.sendSendV3(senderAddress, tick1, 1, destAddress1["address"], "1st SEND test v3", tick2, 2, destAddress2["address"], "2nd SEND test v3")
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
        let broadcastAddress = await cryptoHelper.getNewFundedAddress("BROADCAST.V3", COIN, NETWORK, null, "legacy",0,1)

        // Create a V0 broadcast first so V3 can reference it
        let broadcastV0ActionIndex = await xchainMessageHelper.sendBroadcastV0(
            broadcastAddress,
            "BROADCAST v3 feed",
            1
        )

        await xchainMessageHelper.sendBroadcastV3(
            broadcastAddress,
            broadcastV0ActionIndex,
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
    it('should create a LIST Message v1 with addresses', async () => {
        console.log("Creating new addresses for the test")
        let listAddress0 = await cryptoHelper.getNewFundedAddress("LIST.V1", COIN, NETWORK, null, "legacy",0,1) 
        let listAddress1 = await cryptoHelper.getNewAddress("LIST.V1", COIN, NETWORK, null, "legacy",1) 
        let listAddress2 = await cryptoHelper.getNewAddress("LIST.V1", COIN, NETWORK, null, "legacy",2) 
        let listAddress3 = await cryptoHelper.getNewAddress("LIST.V1", COIN, NETWORK, null, "legacy",3) 
        let listAddress4 = await cryptoHelper.getNewAddress("LIST.V1", COIN, NETWORK, null, "legacy",4) 
        let listAddress5 = await cryptoHelper.getNewAddress("LIST.V1", COIN, NETWORK, null, "legacy",5) 
        let listAddress6 = await cryptoHelper.getNewAddress("LIST.V1", COIN, NETWORK, null, "legacy",6) 
        
        let addressListV0ActionIndex = await xchainMessageHelper.sendListV0(
            listAddress0,
            2, //type 2=ADDRESS
            [
                listAddress1["address"],
                listAddress2["address"],
                listAddress3["address"],
            ]
        )
        
        let addressListV1ActionIndex = await xchainMessageHelper.sendListV1(
            listAddress0,
            1, //edit 1=ADD
            addressListV0ActionIndex,
            [
                listAddress4["address"],
                listAddress5["address"],
                listAddress6["address"],
            ],
            2,
            [
                listAddress1["address"],
                listAddress2["address"],
                listAddress3["address"],
                listAddress4["address"],
                listAddress5["address"],
                listAddress6["address"],
            ]
        )
        
        await xchainMessageHelper.sendListV1(
            listAddress0,
            2, //edit 1=REMOVE
            addressListV1ActionIndex,
            [
                listAddress4["address"]
            ],
            2,
            [
                listAddress1["address"],
                listAddress2["address"],
                listAddress3["address"],
                listAddress5["address"],
                listAddress6["address"],
            ]
        )
    });
    it('should create an AIRDROP Message v0 with an address list', async () => {
        console.log("Creating new addresses for the test")
        let airdropAddressInfo = await cryptoHelper.getNewFundedAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy",0,1) 
        let airdropAddress = airdropAddressInfo["address"]
        let airdropTick = "AIRDROPADDv0"+airdropAddress.substring(airdropAddress.length-8)
        
        //Issue gas token
        //await xchainMessageHelper.sendIssueV0(
        //    airdropAddressInfo,
        //    GAS_TICK, 
        //    1000000000, 
        //    100, 
        //    0, 
        //    "GAS ISSUE", 
        //    100
        //)
        
        //Mint some gas
        await xchainMessageHelper.sendMintV0(
            airdropAddressInfo,
            GAS_TICK, 
            100, 
            airdropAddress,
            ""
        )
        
        //Create the tick to distribute
        await xchainMessageHelper.sendIssueV0(
            airdropAddressInfo,
            airdropTick, 
            100, 
            100, 
            0, 
            "Airdrop address v0 test", 
            100
        )
        
        //Create the list to test
        let listAddressInfo1 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy",1) 
        let listAddressInfo2 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy",2) 
        let listAddressInfo3 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy",3) 
        let listAddressInfo4 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy",4) 
        let listAddressInfo5 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy",5) 
        let listAddressInfo6 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy",6) 
        
        let airdropAddressListActionIndex = await xchainMessageHelper.sendListV0(
            airdropAddressInfo,
            2, //type 2=ADDRESS
            [
                listAddressInfo1["address"],
                listAddressInfo2["address"],
                listAddressInfo3["address"],
                listAddressInfo4["address"],
                listAddressInfo5["address"],
                listAddressInfo6["address"],
            ]
        )
        
        //Create the airdrop
        let airdropAddressesV0ActionIndex = await xchainMessageHelper.sendAirdropV0(
            airdropAddressInfo,
            airdropTick,
            1,
            airdropAddressListActionIndex,
            "AIRDROP ADDRESSES TEST V0"
        )
    });
    it('should create an AIRDROP Message v0 with a tick list', async () => {
        console.log("Creating new addresses for the test")
        let airdropAddressInfo = await cryptoHelper.getNewFundedAddress("AIRDROP.TICKS.V0", COIN, NETWORK, null, "legacy",0,1) 
        let airdropAddress = airdropAddressInfo["address"]
        let airdropTicks = [
            "AIRDROPTICv0Tick1"+airdropAddress.substring(airdropAddress.length-8),
            "AIRDROPTICv0Tick2"+airdropAddress.substring(airdropAddress.length-8),
            "AIRDROPTICv0Tick3"+airdropAddress.substring(airdropAddress.length-8)
        ]
        
        for (let nextTickIndex in airdropTicks){
            await xchainMessageHelper.sendIssueV0(
                airdropAddressInfo,
                airdropTicks[nextTickIndex], 
                100, 
                10, 
                0, 
                "AIRDROP V0 TICK "+nextTickIndex, 
                10
            )
        }
        
        //Mint some gas
        await xchainMessageHelper.sendMintV0(
            airdropAddressInfo,
            GAS_TICK, 
            100, 
            airdropAddress,
            ""
        )
        
        //Create the list to test
        let listAddressInfo1 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy",1) 
        let listAddressInfo2 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy",2) 
        let listAddressInfo3 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy",3) 
        let listAddressInfo4 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy",4) 
        let listAddressInfo5 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy",5) 
        let listAddressInfo6 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy",6) 
        let listAddressesInfo = [
            listAddressInfo1,
            listAddressInfo2,
            listAddressInfo3,
            listAddressInfo4,
            listAddressInfo5,
            listAddressInfo6
        ]
        
        //Send ticks to have some tick1 and tick2 holders
        for (let nextAddressInfoIndex in listAddressesInfo){
            if (nextAddressInfoIndex <= 3){//Send tick1 to the first 4 addresses
                await xchainMessageHelper.sendSendV0(
                    airdropAddressInfo,
                    airdropTicks[0], 
                    1,
                    listAddressesInfo[nextAddressInfoIndex]["address"],
                    "AIRDROP v0 send tick to create holder list "+nextAddressInfoIndex
                )
            } else {
                await xchainMessageHelper.sendSendV0(
                    airdropAddressInfo,
                    airdropTicks[1], 
                    1,
                    listAddressesInfo[nextAddressInfoIndex]["address"],
                    "AIRDROP v0 send tick to create holder list "+nextAddressInfoIndex
                )
            }
        }
        
        //Create the list using the ticks
        let airdropTicksListActionIndex = await xchainMessageHelper.sendListV0(
            airdropAddressInfo,
            1, //type 2=TICKS
            [
                airdropTicks[0],
                airdropTicks[1]
            ]
        )
        
        //Create the airdrop
        let airdropTicksV0ActionIndex = await xchainMessageHelper.sendAirdropV0(
            airdropAddressInfo,
            airdropTicks[2], //Send tick3 to tick1's holders and tick2's holders
            1,
            airdropTicksListActionIndex,
            "AIRDROP TICKS TEST V0"
        )
    });
    it('should create an AIRDROP Message v1 with an address list', async () => {
        console.log("Creating new addresses for the test")
        let airdropAddressInfo = await cryptoHelper.getNewFundedAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy",0,1) 
        let airdropAddress = airdropAddressInfo["address"]
        let airdropTick1 = "AIRDROP1ADDv1"+airdropAddress.substring(airdropAddress.length-8)
        let airdropTick2 = "AIRDROP2ADDv1"+airdropAddress.substring(airdropAddress.length-8)
        
        //Mint some gas
        await xchainMessageHelper.sendMintV0(
            airdropAddressInfo,
            GAS_TICK, 
            100, 
            airdropAddress,
            ""
        )
        
        //Create the ticks to distribute
        await xchainMessageHelper.sendIssueV0(
            airdropAddressInfo,
            airdropTick1, 
            100, 
            100, 
            0, 
            "Airdrop1 address v1 test", 
            100
        )
        
        await xchainMessageHelper.sendIssueV0(
            airdropAddressInfo,
            airdropTick2, 
            100, 
            100, 
            0, 
            "Airdrop2 address v1 test", 
            100
        )
        
        //Create the list to test
        let listAddressInfo1 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy",1) 
        let listAddressInfo2 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy",2) 
        let listAddressInfo3 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy",3) 
        let listAddressInfo4 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy",4) 
        let listAddressInfo5 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy",5) 
        let listAddressInfo6 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy",6) 
        
        let airdropAddressListActionIndex = await xchainMessageHelper.sendListV0(
            airdropAddressInfo,
            2, //type 2=ADDRESS
            [
                listAddressInfo1["address"],
                listAddressInfo2["address"],
                listAddressInfo3["address"],
                listAddressInfo4["address"],
                listAddressInfo5["address"],
                listAddressInfo6["address"],
            ]
        )
        
        //Create the airdrop
        let airdropAddressesV1ActionIndex = await xchainMessageHelper.sendAirdropV1(
            airdropAddressInfo,
            airdropTick1,
            1,
            airdropTick2,
            2,
            airdropAddressListActionIndex,
            "AIRDROP ADDRESSES TEST V1"
        )
    });
    it('should create an AIRDROP Message v2 with an address list', async () => {
        console.log("Creating new addresses for the test")
        let airdropAddressInfo = await cryptoHelper.getNewFundedAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy",0,1) 
        let airdropAddress = airdropAddressInfo["address"]
        let airdropTick1 = "AIRDROP1ADDv2"+airdropAddress.substring(airdropAddress.length-8)
        let airdropTick2 = "AIRDROP2ADDv2"+airdropAddress.substring(airdropAddress.length-8)
        
        //Mint some gas
        await xchainMessageHelper.sendMintV0(
            airdropAddressInfo,
            GAS_TICK, 
            100, 
            airdropAddress,
            ""
        )
        
        //Create the ticks to distribute
        await xchainMessageHelper.sendIssueV0(
            airdropAddressInfo,
            airdropTick1, 
            100, 
            100, 
            0, 
            "Airdrop1 address v2 test", 
            100
        )
        
        await xchainMessageHelper.sendIssueV0(
            airdropAddressInfo,
            airdropTick2, 
            100, 
            100, 
            0, 
            "Airdrop2 address v2 test", 
            100
        )
        
        //Create the lists to test
        let listAddressInfo1 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy",1) 
        let listAddressInfo2 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy",2) 
        let listAddressInfo3 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy",3) 
        let listAddressInfo4 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy",4) 
        let listAddressInfo5 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy",5) 
        let listAddressInfo6 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy",6) 
        
        let airdropAddressListActionIndex1 = await xchainMessageHelper.sendListV0(
            airdropAddressInfo,
            2, //type 2=ADDRESS
            [
                listAddressInfo1["address"],
                listAddressInfo2["address"],
                listAddressInfo3["address"],
                listAddressInfo4["address"]
            ]
        )
        
        let airdropAddressListActionIndex2 = await xchainMessageHelper.sendListV0(
            airdropAddressInfo,
            2, //type 2=ADDRESS
            [
                listAddressInfo5["address"],
                listAddressInfo6["address"],
            ]
        )
        
        //Create the airdrop
        let airdropAddressesV2ActionIndex = await xchainMessageHelper.sendAirdropV2(
            airdropAddressInfo,
            airdropTick1,
            1,
            airdropTick2,
            2,
            airdropAddressListActionIndex1,
            airdropAddressListActionIndex2,
            "AIRDROP ADDRESSES TEST V2"
        )
    });
    it('should create an AIRDROP Message v3 with an address list', async () => {
        console.log("Creating new addresses for the test")
        let airdropAddressInfo = await cryptoHelper.getNewFundedAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy",0,1) 
        let airdropAddress = airdropAddressInfo["address"]
        let airdropTick1 = "AIRDROP1ADDv3"+airdropAddress.substring(airdropAddress.length-8)
        let airdropTick2 = "AIRDROP2ADDv3"+airdropAddress.substring(airdropAddress.length-8)
        
        //Mint some gas
        await xchainMessageHelper.sendMintV0(
            airdropAddressInfo,
            GAS_TICK, 
            100, 
            airdropAddress,
            ""
        )
        
        //Create the ticks to distribute
        await xchainMessageHelper.sendIssueV0(
            airdropAddressInfo,
            airdropTick1, 
            100, 
            100, 
            0, 
            "Airdrop1 address v3 test", 
            100
        )
        
        await xchainMessageHelper.sendIssueV0(
            airdropAddressInfo,
            airdropTick2, 
            100, 
            100, 
            0, 
            "Airdrop2 address v3 test", 
            100
        )
        
        //Create the lists to test
        let listAddressInfo1 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy",1) 
        let listAddressInfo2 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy",2) 
        let listAddressInfo3 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy",3) 
        let listAddressInfo4 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy",4) 
        let listAddressInfo5 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy",5) 
        let listAddressInfo6 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy",6) 
        
        let airdropAddressListActionIndex1 = await xchainMessageHelper.sendListV0(
            airdropAddressInfo,
            2, //type 2=ADDRESS
            [
                listAddressInfo1["address"],
                listAddressInfo2["address"],
                listAddressInfo3["address"],
                listAddressInfo4["address"]
            ]
        )
        
        let airdropAddressListActionIndex2 = await xchainMessageHelper.sendListV0(
            airdropAddressInfo,
            2, //type 2=ADDRESS
            [
                listAddressInfo5["address"],
                listAddressInfo6["address"],
            ]
        )
        
        //Create the airdrop
        let airdropAddressesV3ActionIndex = await xchainMessageHelper.sendAirdropV3(
            airdropAddressInfo,
            airdropTick1,
            1,
            airdropTick2,
            2,
            airdropAddressListActionIndex1,
            airdropAddressListActionIndex2,
            "AIRDROP ADDRESSES TEST V3 memo1",
            "AIRDROP ADDRESSES TEST V3 memo2"
        )
    });
    it('should create a DISPENSER Message v0', async () => {
        console.log("Creating new addresses for the test")
        let dispenserAddressInfo = await cryptoHelper.getNewFundedAddress("DISPENSER.V0", COIN, NETWORK, null, "legacy",0,1) 
        let dispenserAddress = dispenserAddressInfo["address"]
        let dispenserTick = "DISPENSERv0"+dispenserAddress.substring(dispenserAddress.length-8)
        
        //Create the tick to dispense
        await xchainMessageHelper.sendIssueV0(
            dispenserAddressInfo,
            dispenserTick, 
            100, 
            100, 
            0, 
            "Dispenser v0 test", 
            100
        )
        
        let expirationDate = new Date()
        expirationDate.setMonth(expirationDate.getMonth() + 3)
        
        //Create the dispenser
        let dispenserV0ActionIndex = await xchainMessageHelper.sendDispenserV0(
            dispenserAddressInfo,
            COIN_CODE,
            dispenserTick,
            1,
            10,
            COIN_CODE,
            null,
            5,
            dispenserAddressInfo["address"],
            null,
            null,
            Math.floor(expirationDate.getTime() / 1000),//expiration
            null,
            null,
            'This is a dispenser v0 test'
        )
    });
    it('should dispense a token from a dispenser', async () => {
        console.log("Creating new addresses for the test")
        let dispenserAddressInfo = await cryptoHelper.getNewFundedAddress("DISPENSER.V0.DISPENSE", COIN, NETWORK, null, "legacy",0,1) 
        let dispenseAddressInfo = await cryptoHelper.getNewFundedAddress("DISPENSE", COIN, NETWORK, null, "legacy",0,1) 
        let dispenserAddress = dispenserAddressInfo["address"]
        let dispenseAddress = dispenseAddressInfo["address"]
        let dispenserTick = "DISPENSERv0DISPENSE"+dispenserAddress.substring(dispenserAddress.length-8)
        
        //Create the tick to dispense
        await xchainMessageHelper.sendIssueV0(
            dispenserAddressInfo,
            dispenserTick, 
            100, 
            100, 
            0, 
            "Dispenser v0 test to dispense", 
            100
        )
        
        let expirationDate = new Date()
        expirationDate.setMonth(expirationDate.getMonth() + 3)
        
        //Create the dispenser
        let dispenserV0ActionIndex = await xchainMessageHelper.sendDispenserV0(
            dispenserAddressInfo,
            COIN_CODE,
            dispenserTick,
            1,
            10,
            COIN_CODE,
            null,
            0.05,
            dispenserAddressInfo["address"],
            null,
            null,
            Math.floor(expirationDate.getTime() / 1000),//expiration
            null,
            null,
            'This is a dispenser v0 test to dispense'
        )

        //Get a dispense
        let txHash = await transactionHelper.createSimpleTransaction(
            dispenseAddressInfo,
            dispenserAddress,
            5000000
        )

        //Check if the dispense exists
        console.log("Waiting for DISPENSE in the database (txHash: "+txHash+")...")
        let dispenseActionIndex = await indexerDatabase.waitForDispense({
            txHash: txHash,
            source: dispenseAddressInfo["address"],
            giveCoin: COIN_CODE,
            giveTick: dispenserTick,
            giveAmount: 1,
            getCoin: COIN_CODE,
            getAmount: 0.05,
            destination: dispenseAddressInfo["address"],
            status: "valid"
        }, 60000)

        if (dispenseActionIndex < 0) {
            // Debug: query without filters to see if any dispense exists for this tx
            let debugResult = await indexerDatabase.waitForDispense({ txHash: txHash }, 5000)
            console.log("Debug - dispense by txHash only:", debugResult)
            let debugResult2 = await indexerDatabase.waitForDispense({ source: dispenseAddressInfo["address"] }, 5000)
            console.log("Debug - dispense by source only:", debugResult2)
        }
        assert(dispenseActionIndex >= 0)
    });
})
