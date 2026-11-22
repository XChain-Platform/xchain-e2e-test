// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const transactionHelper = require('./core/transactionHelper')
const requireRow = require('./requireRow')

module.exports = {
    // ORDER v0 wire format:
    //   VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
    // giveOwnership / getOwnership are optional (default empty = 0). When set to 1,
    // the corresponding *Amount field is sent empty per the spec.
    async sendOrderV0(addressInfo, giveCoin, giveTick, giveAmount, getCoin, getTick, getAmount,
      getAddress, expiration, allowList, blockList, memo, giveOwnership, getOwnership
    ){
        if (getAddress == null) getAddress = ""
        if (expiration == null) expiration = ""
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""
        if (giveOwnership == null) giveOwnership = ""
        if (getOwnership == null) getOwnership = ""
        // Wire-format: ownership side carries empty *_AMOUNT, native-coin side carries
        // empty *_TICK. The DB stores NULL for both. The waitFor predicate has to query
        // with null (not "") on those sides or the row will never match.
        const giveAmountWire = (giveOwnership == 1) ? "" : giveAmount
        const getAmountWire  = (getOwnership  == 1) ? "" : getAmount
        const giveAmountQuery = (giveOwnership == 1) ? null : giveAmount
        const getAmountQuery  = (getOwnership  == 1) ? null : getAmount
        const giveTickQuery = (giveTick === "" || giveTick == null) ? null : giveTick
        const getTickQuery  = (getTick  === "" || getTick  == null) ? null : getTick

        const orderMessage = "ORDER|0|"+giveCoin+"|"+giveTick+"|"+giveAmountWire+"|"+giveOwnership
            +"|"+getCoin+"|"+getTick+"|"+getAmountWire+"|"+getOwnership+"|"+getAddress
            +"|"+expiration+"|"+allowList+"|"+blockList+"|"+memo

        console.log("Creating and sending ORDER V0 tx...")
        const txHash = await transactionHelper.createAndSendTransaction(addressInfo, orderMessage)

        console.log("Waiting for ORDER in the database...")
        const row = requireRow(await indexerDatabase.waitForOrder({
            txHash: txHash,
            source: addressInfo["address"],
            giveCoin: giveCoin,
            giveTick: giveTickQuery,
            giveAmount: giveAmountQuery,
            getCoin: getCoin,
            getTick: getTickQuery,
            getAmount: getAmountQuery,
            status: "valid"
        }), "sendOrderV0: ORDER giving " + giveCoin + "/" + giveTick + " for "
            + getCoin + "/" + getTick + " (tx " + txHash + ") at status=valid")

        return { txHash, order: row }
    },

    async sendOrderCancelV1(addressInfo, orderActionIndex, memo){
        const orderMessage = "ORDER|1|"+orderActionIndex+"|"+memo

        console.log("Creating and sending ORDER CANCEL V1 tx...")
        const txHash = await transactionHelper.createAndSendTransaction(addressInfo, orderMessage)

        console.log("Waiting for ORDER cancel to be indexed...")
        await new Promise(r => setTimeout(r, 5000))

        return { txHash }
    },

    async sendOrderEditV2(addressInfo, orderActionIndex, expiration, allowList, blockList, memo){
        if (expiration == null) expiration = ""
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""

        const orderMessage = "ORDER|2|"+orderActionIndex
            +"|"+expiration+"|"+allowList+"|"+blockList+"|"+(memo || "")

        console.log("Creating and sending ORDER EDIT V2 tx...")
        const txHash = await transactionHelper.createAndSendTransaction(addressInfo, orderMessage)

        console.log("Waiting for ORDER edit to be indexed...")
        await new Promise(r => setTimeout(r, 5000))

        return { txHash }
    }
}
