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
    async sendBatchV0(addressInfo, commands){
        let batchMessage = "BATCH|0|"+commands.join(";")

        console.log("Creating and sending BATCH V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, batchMessage)

        console.log("Waiting for BATCH in the database...")
        let row = await indexerDatabase.waitForBatch({
            txHash: txHash,
            source: addressInfo["address"],
            status: "valid"
        })

        return { txHash, batch: row }
    }
}
