// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendCallbackV0(addressInfo, tick, memo){
        let callbackMessage = "CALLBACK|0|"+tick+"|"+memo

        console.log("Creating and sending CALLBACK V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, callbackMessage)

        console.log("Waiting for CALLBACK in the database...")
        let row = await indexerDatabase.waitForCallback({
            txHash: txHash,
            source: addressInfo["address"],
            tick: tick,
            status: "valid"
        })

        return { txHash, callback: row }
    }
}
