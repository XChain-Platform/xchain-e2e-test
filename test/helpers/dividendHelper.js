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
    async sendDividendV0(addressInfo, tick, dividendTick, amount, memo){
        let dividendMessage = "DIVIDEND|0|"+tick+"|"+dividendTick+"|"+amount+"|"+memo

        console.log("Creating and sending DIVIDEND V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, dividendMessage)

        console.log("Waiting for DIVIDEND in the database...")
        let row = await indexerDatabase.waitForDividend({
            txHash: txHash,
            source: addressInfo["address"],
            tick: tick,
            dividendTick: dividendTick,
            amount: amount,
            status: "valid"
        })

        return { txHash, dividend: row }
    }
}
