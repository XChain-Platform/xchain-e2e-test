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
    async sendFileV0(addressInfo, name, type, title, memo, rawData){
        let fileMessage = "FILE|0|"+name+"|"+type+"|"+title+"|"+memo

        console.log("Creating and sending FILE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, fileMessage, rawData)

        console.log("Waiting for FILE in the database...")
        let row = await indexerDatabase.waitForFile({
            txHash: txHash,
            source: addressInfo["address"],
            name: name,
            title: title,
            status: "valid"
        })

        return { txHash, file: row }
    }
}
