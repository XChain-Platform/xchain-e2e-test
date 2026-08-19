// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendIssueV0(addressInfo, tick, maxSupply, maxMint, decimals, description, mintSupply,
        transfer='', transferSupply='', lockMaxSupply='', lockMaxMint='', lockDescription='',
        lockSleep='', lockCallback='', callbackBlock='', callbackTick='', callbackAmount='',
        allowList='', blockList='', mintAddressMax='', mintStartBlock='', mintStopBlock='', lockMint='',
        lockMintSupply='', outputType=null, compressedPubKey=null
    ){
        let address = addressInfo["address"]

        let issueMessage = "ISSUE|0|"+tick+"|"+maxSupply
            +"|"+maxMint+"|"+decimals+"|"+description+"|"+mintSupply
            +"|"+transfer+"|"+transferSupply+"|"+lockMaxSupply+"|"+lockMaxMint
            +"|"+lockDescription+"|"+lockSleep+"|"+lockCallback
            +"|"+callbackBlock+"|"+callbackTick+"|"+callbackAmount+"|"+allowList
            +"|"+blockList+"|"+mintAddressMax+"|"+mintStartBlock+"|"+mintStopBlock
            +"|"+lockMint+"|"+lockMintSupply

        console.log("Creating and sending ISSUE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage, null, [], outputType, compressedPubKey)

        console.log("Waiting for ISSUE in the database...")
        let issueRow = await indexerDatabase.waitForIssue({
            source: address,
            tick: tick,
            txHash: txHash,
            description: description,
            maxSupply: maxSupply,
            maxMint: maxMint,
            decimals: decimals,
            mintSupply: mintSupply,
            status: "valid"
        })
        // Fail HERE, not three assertions later. A caller of this helper is
        // setting up a fixture it needs to exist; returning a null row lets the
        // test walk on and fail somewhere misleading (a rejected parent ISSUE
        // leaves its tick interned but valueless, so a dependent action fails
        // on the wrong rule and the real rejection never surfaces).
        if(!issueRow)
            throw new Error("sendIssueV0: ISSUE " + tick + " (tx " + txHash + ") never reached "
                + "status=valid; the checkIssue give-up line above says whether the row is "
                + "absent or landed with another status - read the indexer's verdict for this tx")

        let creditRow = await indexerDatabase.waitForCredit({
            address: address,
            tick: tick,
            txHash: txHash,
            amount: mintSupply
        })
        if(!creditRow)
            throw new Error("sendIssueV0: ISSUE " + tick + " (tx " + txHash + ") is valid but its "
                + "mint credit of " + mintSupply + " never appeared")

        return { txHash, issue: issueRow, credit: creditRow }
    },

    async sendIssueV1(addressInfo, tick, description){
        let address = addressInfo["address"]

        let issueMessage = "ISSUE|1|"+tick+"|"+description

        console.log("Creating and sending ISSUE V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)

        console.log("Waiting for ISSUE in the database...")
        let issueRow = await indexerDatabase.waitForIssue({
            source: address,
            tick: tick,
            txHash: txHash,
            description: description,
            status: "valid"
        })

        return { txHash, issue: issueRow }
    },

    async sendIssueV2(addressInfo, tick, maxMint, mintSupply, transferSupply, mintAddressMax, mintStartBlock, mintStopBlock, memo){
        let address = addressInfo["address"]
        if (transferSupply == null) transferSupply = ""
        if (mintAddressMax == null) mintAddressMax = ""
        if (mintStartBlock == null) mintStartBlock = ""
        if (mintStopBlock == null) mintStopBlock = ""
        if (memo == null) memo = ""

        let issueMessage = "ISSUE|2|"+tick+"|"+maxMint+"|"+mintSupply
            +"|"+transferSupply+"|"+mintAddressMax+"|"+mintStartBlock+"|"+mintStopBlock+"|"+memo

        console.log("Creating and sending ISSUE V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)

        console.log("Waiting for ISSUE in the database...")
        let issueRow = await indexerDatabase.waitForIssue({
            source: address,
            tick: tick,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, issue: issueRow }
    },

    async sendIssueV3(addressInfo, tick, lockMaxSupply, lockMaxMint, lockDescription, lockSleep, lockCallback, lockMint, lockMintSupply, memo){
        let address = addressInfo["address"]
        if (lockMaxSupply == null) lockMaxSupply = ""
        if (lockMaxMint == null) lockMaxMint = ""
        if (lockDescription == null) lockDescription = ""
        if (lockSleep == null) lockSleep = ""
        if (lockCallback == null) lockCallback = ""
        if (lockMint == null) lockMint = ""
        if (lockMintSupply == null) lockMintSupply = ""
        if (memo == null) memo = ""

        let issueMessage = "ISSUE|3|"+tick+"|"+lockMaxSupply+"|"+lockMaxMint
            +"|"+lockDescription+"|"+lockSleep+"|"+lockCallback+"|"+lockMint+"|"+lockMintSupply+"|"+memo

        console.log("Creating and sending ISSUE V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)

        console.log("Waiting for ISSUE in the database...")
        let issueRow = await indexerDatabase.waitForIssue({
            source: address,
            tick: tick,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, issue: issueRow }
    },

    async sendIssueV4(addressInfo, tick, callbackBlock, callbackTick, callbackAmount, memo){
        let address = addressInfo["address"]
        if (callbackBlock == null) callbackBlock = ""
        if (callbackTick == null) callbackTick = ""
        if (callbackAmount == null) callbackAmount = ""
        if (memo == null) memo = ""

        let issueMessage = "ISSUE|4|"+tick+"|"+callbackBlock+"|"+callbackTick+"|"+callbackAmount+"|"+memo

        console.log("Creating and sending ISSUE V4 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)

        console.log("Waiting for ISSUE in the database...")
        let issueRow = await indexerDatabase.waitForIssue({
            source: address,
            tick: tick,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, issue: issueRow }
    },

    async sendIssueV5(addressInfo, tick, allowList, blockList, memo){
        let address = addressInfo["address"]
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""
        if (memo == null) memo = ""

        let issueMessage = "ISSUE|5|"+tick+"|"+allowList+"|"+blockList+"|"+memo

        console.log("Creating and sending ISSUE V5 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)

        console.log("Waiting for ISSUE in the database...")
        let issueRow = await indexerDatabase.waitForIssue({
            source: address,
            tick: tick,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, issue: issueRow }
    }
}
