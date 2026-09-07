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

module.exports = {
    // DISPENSER v0 wire format:
    //   VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
    // giveOwnership is optional (default empty = 0). When set to 1, the dispenser sells
    // ownership of GIVE_TICK as a single-shot transfer (GIVE_AMOUNT and GIVE_ESCROW must be empty).
    async sendDispenserV0(addressInfo, giveCoin, giveTick, giveAmount,
      giveEscrow, getCoin, getTick, getAmount, getAddress, fiatCode,
      fiatAmount, oracleAddress, expiration, allowList, blockList, memo, giveOwnership,
      customOutputs, expectedStatus
    ){
        let address = addressInfo["address"]

        if (giveCoin == null) giveCoin = ""
        if (giveTick == null) giveTick = ""
        if (getCoin == null) getCoin = ""
        if (getTick == null) getTick = ""
        if (fiatCode == null) fiatCode = ""
        if (fiatAmount == null) fiatAmount = ""
        if (oracleAddress == null) oracleAddress = ""
        if (expiration == null) expiration = ""
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""
        if (memo == null) memo = ""
        if (giveOwnership == null) giveOwnership = ""
        // Wire-format: ownership dispenser carries empty GIVE_AMOUNT and GIVE_ESCROW.
        // The DB stores NULL for those, so waitFor must query with null (not "").
        let giveAmountWire  = (giveOwnership == 1) ? "" : giveAmount
        let giveEscrowWire  = (giveOwnership == 1) ? "" : giveEscrow
        let giveAmountQuery = (giveOwnership == 1) ? null : giveAmount
        let giveEscrowQuery = (giveOwnership == 1) ? null : giveEscrow

        let dispenserMessage = "DISPENSER|0"
            +"|"+giveCoin+"|"+giveTick+"|"+giveAmountWire+"|"+giveOwnership+"|"+giveEscrowWire
            +"|"+getCoin+"|"+getTick+"|"+getAmount+"|"+getAddress
            +"|"+fiatCode+"|"+fiatAmount+"|"+oracleAddress
            +"|"+expiration+"|"+allowList+"|"+blockList+"|"+memo

        console.log("Creating and sending DISPENSER V0 tx...")
        // customOutputs carries the oracle usage fee output when the dispenser
        // names an ORACLE_ADDRESS whose operator charges a fee.
        let txHash = await transactionHelper.createAndSendTransaction(
            addressInfo, dispenserMessage, null, Array.isArray(customOutputs) ? customOutputs : [])

        let dispenserRow = requireRow(await indexerDatabase.waitForDispenser({
            source: address, txHash: txHash,
            giveCoin: giveCoin, giveTick: giveTick,
            giveAmount: giveAmountQuery, giveEscrow: giveEscrowQuery,
            getCoin: getCoin, getTick: getTick,
            getAmount: getAmount, getAddress: getAddress,
            fiatCode: fiatCode, fiatAmount: fiatAmount,
            expiration: expiration, allowList: allowList,
            blockList: blockList, memo: memo,
            // expectedStatus lets a caller wait for a REJECTED create (oracle
            // fee): waiting on "valid" would just time out.
            status: expectedStatus || "valid"
        }), "sendDispenserV0: DISPENSER giving " + giveTick + " for " + getTick
            + " (tx " + txHash + ") at status=" + (expectedStatus || "valid"))

        return { txHash, dispenser: dispenserRow }
    },

    async sendDispenserCancelV1(addressInfo, dispenserActionIndex, memo){
        let msg = "DISPENSER|1|"+dispenserActionIndex+"|"+(memo || "")

        console.log("Creating and sending DISPENSER CANCEL V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for DISPENSER cancel to be indexed...")
        await new Promise(r => setTimeout(r, 5000))

        return { txHash }
    },

    async sendDispenserEditV2(addressInfo, dispenserActionIndex, giveEscrow, expiration, allowList, blockList, memo){
        if (giveEscrow == null) giveEscrow = ""
        if (expiration == null) expiration = ""
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""

        let msg = "DISPENSER|2|"+dispenserActionIndex
            +"|"+giveEscrow+"|"+expiration+"|"+allowList+"|"+blockList+"|"+(memo || "")

        console.log("Creating and sending DISPENSER EDIT V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for DISPENSER edit to be indexed...")
        await new Promise(r => setTimeout(r, 5000))

        return { txHash }
    }
}
