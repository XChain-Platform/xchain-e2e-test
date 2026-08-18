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
    // MEMO sits BEFORE the variadic ITEM tail, so a memo-less LIST still spends an
    // empty segment on it (LIST|0|1||JDOG|BRRR). Omit it and the first item is
    // parsed AS the memo, silently landing a list one item short.
    async sendListV0(addressInfo, type, items, memo = ''){
        let address = addressInfo["address"]
        let listMessage = "LIST|0|"+type+"|"+memo+"|"+items.join("|")

        console.log("Creating and sending LIST V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, listMessage)

        let listRow = await indexerDatabase.waitForList({
            source: address, txHash: txHash, type: type,
            status: "valid", items
        })

        return { txHash, list: listRow }
    },

    // memo is last so the existing positional callers keep working; see sendListV0
    // for why the segment is spent even when empty.
    async sendListV1(addressInfo, edit, listActionIndex, items, finalTypeToCheck, finalItemsToCheck, memo = ''){
        let address = addressInfo["address"]
        let listMessage = "LIST|1|"+edit+"|"+listActionIndex+"|"+memo+"|"+items.join("|")

        console.log("Creating and sending LIST V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, listMessage)

        let listRow = await indexerDatabase.waitForList({
            source: address, txHash: txHash, type: finalTypeToCheck,
            status: "valid", items: finalItemsToCheck
        })

        return { txHash, list: listRow }
    }
}
