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
    // MEMO sits BEFORE the variadic ITEM tail, so a memo-less LIST still spends an
    // empty segment on it (LIST|0|1||JDOG|BRRR). Qualified TICK items require
    // explicit expectedItems because the indexer stores their canonical form.
    async sendListV0(addressInfo, type, items, memo = '', expectedItems = null){
        const qualifiedItems = items.filter((item) => String(item).includes(':'))
        if (String(type) === '1' && expectedItems == null && qualifiedItems.length > 0){
            throw new Error('sendListV0: coin-qualified TICK item(s) ' + qualifiedItems.join(', ') +
                ' require expectedItems in the canonical stored form')
        }
        const address = addressInfo["address"]
        const listMessage = "LIST|0|"+type+"|"+memo+"|"+items.join("|")

        console.log("Creating and sending LIST V0 tx...")
        const txHash = await transactionHelper.createAndSendTransaction(addressInfo, listMessage)

        const listRow = requireRow(await indexerDatabase.waitForList({
            source: address, txHash: txHash, type: type,
            status: "valid", items: expectedItems ?? items
        }), "sendListV0: LIST type " + type + " of " + items.length + " items (tx "
            + txHash + ") at status=valid")

        return { txHash, list: listRow }
    },

    // memo is last so the existing positional callers keep working; see sendListV0
    // for why the segment is spent even when empty.
    async sendListV1(addressInfo, edit, listActionIndex, items, finalTypeToCheck, finalItemsToCheck, memo = ''){
        const address = addressInfo["address"]
        const listMessage = "LIST|1|"+edit+"|"+listActionIndex+"|"+memo+"|"+items.join("|")

        console.log("Creating and sending LIST V1 tx...")
        const txHash = await transactionHelper.createAndSendTransaction(addressInfo, listMessage)

        const listRow = requireRow(await indexerDatabase.waitForList({
            source: address, txHash: txHash, type: finalTypeToCheck,
            status: "valid", items: finalItemsToCheck
        }), "sendListV1: the edited LIST " + listActionIndex + " at type "
            + finalTypeToCheck + " (tx " + txHash + ") at status=valid")

        return { txHash, list: listRow }
    }
}
