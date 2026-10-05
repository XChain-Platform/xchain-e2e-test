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
const requireRow = require('./requireRow')

function waitForIndexer(method, query, waitMs){
    if(waitMs === undefined) return method.call(indexerDatabase, query)
    return method.call(indexerDatabase, query, waitMs)
}

async function sendIssueV0AndWait(helper, waitMs, args){
    const [addressInfo, tick, maxSupply, maxMint, decimals, description, mintSupply] = args
    const txHash = await helper.sendIssueV0Raw(...args)

    console.log("Waiting for ISSUE in the database...")
    const issueRow = await waitForIndexer(indexerDatabase.waitForIssue, {
        source: addressInfo.address,
        tick: tick,
        txHash: txHash,
        description: description,
        maxSupply: maxSupply,
        maxMint: maxMint,
        decimals: decimals,
        mintSupply: mintSupply,
        status: "valid"
    }, waitMs)
    if(!issueRow)
        throw new Error("sendIssueV0: ISSUE " + tick + " (tx " + txHash + ") never reached "
            + "status=valid; the checkIssue give-up line above says whether the row is "
            + "absent or landed with another status - read the indexer's verdict for this tx")

    const creditRow = await waitForIndexer(indexerDatabase.waitForCredit, {
        address: addressInfo.address,
        tick: tick,
        txHash: txHash,
        amount: mintSupply
    }, waitMs)
    if(!creditRow)
        throw new Error("sendIssueV0: ISSUE " + tick + " (tx " + txHash + ") is valid but its "
            + "mint credit of " + mintSupply + " never appeared")

    return { txHash, issue: issueRow, credit: creditRow }
}

module.exports = {
    // Broadcast an ISSUE v0 and return its txHash, waiting for NO particular
    // indexer verdict. This is the helper for a test asserting a REJECTION:
    // sendIssueV0 below demands status=valid, which is what ~190 of its callers
    // want (they are building a fixture) and exactly wrong for the few sending
    // an ISSUE the protocol is supposed to refuse. Those tests own the wait,
    // because only they know which refusal they expect.
    //
    // Kept here rather than hand-rolled in each test so the v0 field order lives
    // in ONE place: the message is 24 pipe-separated fields and a test that
    // reproduces it from memory silently shifts every field after the one it
    // drops.
    async sendIssueV0Raw(addressInfo, tick, maxSupply, maxMint, decimals, description, mintSupply,
        transfer='', transferSupply='', lockMaxSupply='', lockMaxMint='', lockDescription='',
        lockSleep='', lockCallback='', callbackBlock='', callbackTick='', callbackAmount='',
        allowList='', blockList='', mintAddressMax='', mintStartBlock='', mintStopBlock='', lockMint='',
        lockMintSupply='', outputType=null, compressedPubKey=null
    ){
        const issueMessage = "ISSUE|0|"+tick+"|"+maxSupply
            +"|"+maxMint+"|"+decimals+"|"+description+"|"+mintSupply
            +"|"+transfer+"|"+transferSupply+"|"+lockMaxSupply+"|"+lockMaxMint
            +"|"+lockDescription+"|"+lockSleep+"|"+lockCallback
            +"|"+callbackBlock+"|"+callbackTick+"|"+callbackAmount+"|"+allowList
            +"|"+blockList+"|"+mintAddressMax+"|"+mintStartBlock+"|"+mintStopBlock
            +"|"+lockMint+"|"+lockMintSupply

        console.log("Creating and sending ISSUE V0 tx...")
        return await transactionHelper.createAndSendTransaction(addressInfo, issueMessage, null, [], outputType, compressedPubKey)
    },

    async sendIssueV0(addressInfo, tick, maxSupply, maxMint, decimals, description, mintSupply,
        transfer='', transferSupply='', lockMaxSupply='', lockMaxMint='', lockDescription='',
        lockSleep='', lockCallback='', callbackBlock='', callbackTick='', callbackAmount='',
        allowList='', blockList='', mintAddressMax='', mintStartBlock='', mintStopBlock='', lockMint='',
        lockMintSupply='', outputType=null, compressedPubKey=null
    ){
        return sendIssueV0AndWait(this, undefined, Array.from(arguments))
    },

    async sendIssueV0Waiting(waitMs, addressInfo, tick, maxSupply, maxMint, decimals, description, mintSupply){
        return sendIssueV0AndWait(this, waitMs, [
            addressInfo, tick, maxSupply, maxMint, decimals, description, mintSupply
        ])
    },

    // Broadcast an ISSUE v1 and return its txHash, waiting for NO verdict. The
    // sendIssueV0Raw contract, for the same reason: sendIssueV1 demands
    // status=valid, which is wrong for a test sending an edit the protocol is
    // supposed to refuse (an ownership-escrowed tick). Those tests own the wait.
    async sendIssueV1Raw(addressInfo, tick, description){
        const issueMessage = "ISSUE|1|"+tick+"|"+description

        console.log("Creating and sending ISSUE V1 tx (raw, no verdict awaited)...")
        return await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)
    },

    async sendIssueV1(addressInfo, tick, description){
        const address = addressInfo["address"]

        const issueMessage = "ISSUE|1|"+tick+"|"+description

        console.log("Creating and sending ISSUE V1 tx...")
        const txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)

        console.log("Waiting for ISSUE in the database...")
        const issueRow = requireRow(await indexerDatabase.waitForIssue({
            source: address,
            tick: tick,
            txHash: txHash,
            description: description,
            status: "valid"
        }), "sendIssueV1: ISSUE " + tick + " (tx " + txHash + ") at status=valid")

        return { txHash, issue: issueRow }
    },

    async sendIssueV2(addressInfo, tick, maxMint, mintSupply, transferSupply, mintAddressMax, mintStartBlock, mintStopBlock, memo){
        const address = addressInfo["address"]
        if (transferSupply == null) transferSupply = ""
        if (mintAddressMax == null) mintAddressMax = ""
        if (mintStartBlock == null) mintStartBlock = ""
        if (mintStopBlock == null) mintStopBlock = ""
        if (memo == null) memo = ""

        const issueMessage = "ISSUE|2|"+tick+"|"+maxMint+"|"+mintSupply
            +"|"+transferSupply+"|"+mintAddressMax+"|"+mintStartBlock+"|"+mintStopBlock+"|"+memo

        console.log("Creating and sending ISSUE V2 tx...")
        const txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)

        console.log("Waiting for ISSUE in the database...")
        const issueRow = requireRow(await indexerDatabase.waitForIssue({
            source: address,
            tick: tick,
            txHash: txHash,
            status: "valid"
        }), "sendIssueV2: ISSUE " + tick + " (tx " + txHash + ") at status=valid")

        return { txHash, issue: issueRow }
    },

    async sendIssueV3(addressInfo, tick, lockMaxSupply, lockMaxMint, lockDescription, lockSleep, lockCallback, lockMint, lockMintSupply, memo){
        const address = addressInfo["address"]
        if (lockMaxSupply == null) lockMaxSupply = ""
        if (lockMaxMint == null) lockMaxMint = ""
        if (lockDescription == null) lockDescription = ""
        if (lockSleep == null) lockSleep = ""
        if (lockCallback == null) lockCallback = ""
        if (lockMint == null) lockMint = ""
        if (lockMintSupply == null) lockMintSupply = ""
        if (memo == null) memo = ""

        const issueMessage = "ISSUE|3|"+tick+"|"+lockMaxSupply+"|"+lockMaxMint
            +"|"+lockDescription+"|"+lockSleep+"|"+lockCallback+"|"+lockMint+"|"+lockMintSupply+"|"+memo

        console.log("Creating and sending ISSUE V3 tx...")
        const txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)

        console.log("Waiting for ISSUE in the database...")
        const issueRow = requireRow(await indexerDatabase.waitForIssue({
            source: address,
            tick: tick,
            txHash: txHash,
            status: "valid"
        }), "sendIssueV3: ISSUE " + tick + " (tx " + txHash + ") at status=valid")

        return { txHash, issue: issueRow }
    },

    async sendIssueV4(addressInfo, tick, callbackBlock, callbackTick, callbackAmount, memo){
        const address = addressInfo["address"]
        if (callbackBlock == null) callbackBlock = ""
        if (callbackTick == null) callbackTick = ""
        if (callbackAmount == null) callbackAmount = ""
        if (memo == null) memo = ""

        const issueMessage = "ISSUE|4|"+tick+"|"+callbackBlock+"|"+callbackTick+"|"+callbackAmount+"|"+memo

        console.log("Creating and sending ISSUE V4 tx...")
        const txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)

        console.log("Waiting for ISSUE in the database...")
        const issueRow = requireRow(await indexerDatabase.waitForIssue({
            source: address,
            tick: tick,
            txHash: txHash,
            status: "valid"
        }), "sendIssueV4: ISSUE " + tick + " (tx " + txHash + ") at status=valid")

        return { txHash, issue: issueRow }
    },

    // Broadcast an ISSUE v5 and return its txHash, waiting for NO verdict; see
    // sendIssueV0Raw. The list edit is owner-only, so a test proving it is
    // refused on an escrowed tick has to send it without demanding validity.
    async sendIssueV5Raw(addressInfo, tick, allowList, blockList, memo){
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""
        if (memo == null) memo = ""

        const issueMessage = "ISSUE|5|"+tick+"|"+allowList+"|"+blockList+"|"+memo

        console.log("Creating and sending ISSUE V5 tx (raw, no verdict awaited)...")
        return await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)
    },

    async sendIssueV5(addressInfo, tick, allowList, blockList, memo){
        const address = addressInfo["address"]
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""
        if (memo == null) memo = ""

        const issueMessage = "ISSUE|5|"+tick+"|"+allowList+"|"+blockList+"|"+memo

        console.log("Creating and sending ISSUE V5 tx...")
        const txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)

        console.log("Waiting for ISSUE in the database...")
        const issueRow = requireRow(await indexerDatabase.waitForIssue({
            source: address,
            tick: tick,
            txHash: txHash,
            status: "valid"
        }), "sendIssueV5: ISSUE " + tick + " (tx " + txHash + ") at status=valid")

        return { txHash, issue: issueRow }
    }
}
