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
    // SWEEP v0 wire format:
    //   VERSION|DESTINATION|BALANCES|OWNERSHIPS|ORDERS|SWAPS|DISPENSERS|MEMO
    // The single ESCROWS flag was split into three per-primitive flags as part of the
    // ownership-sales work. Each flag defaults to 0 except BALANCES/OWNERSHIPS which
    // default to 1 to match the indexer's own SWEEP defaults.
    async sendSweepV0(addressInfo, destination, balances, ownerships, orders, swaps, dispensers, memo){
        if (balances == null) balances = 1
        if (ownerships == null) ownerships = 1
        if (orders == null) orders = 0
        if (swaps == null) swaps = 0
        if (dispensers == null) dispensers = 0

        let sweepMessage = "SWEEP|0|"+destination
            +"|"+balances+"|"+ownerships
            +"|"+orders+"|"+swaps+"|"+dispensers+"|"+memo

        console.log("Creating and sending SWEEP V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sweepMessage)

        console.log("Waiting for SWEEP in the database...")
        let row = await indexerDatabase.waitForSweep({
            txHash: txHash,
            source: addressInfo["address"],
            destination: destination,
            status: "valid"
        })

        return { txHash, sweep: row }
    }
}
