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
    async sendLinkV0(addressInfo, coin1, coin1ActionIndex, coin2, coin2ActionIndex, memo){
        let linkMessage = "LINK|0|"+coin1+"|"+coin1ActionIndex+"|"+coin2+"|"+coin2ActionIndex+"|"+memo

        console.log("Creating and sending LINK V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, linkMessage)

        console.log("Waiting for LINK in the database...")
        let row = await indexerDatabase.waitForLink({
            txHash: txHash,
            source: addressInfo["address"],
            coin1: coin1,
            coin1ActionIndex: coin1ActionIndex,
            coin2: coin2,
            coin2ActionIndex: coin2ActionIndex,
            status: "valid"
        })

        return { txHash, link: row }
    }
}
