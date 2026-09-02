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
    async sendDestroyV0(addressInfo, tick, amount, memo){
        let destroyMessage = "DESTROY|0|"+tick+"|"+amount+"|"+memo

        console.log("Creating and sending DESTROY V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, destroyMessage)

        console.log("Waiting for DESTROY in the database...")
        let destroyRow = requireRow(await indexerDatabase.waitForDestroy({
            txHash: txHash,
            source: addressInfo["address"],
            tick: tick,
            amount: amount,
            status: "valid"
        }), "sendDestroyV0: DESTROY of " + amount + " " + tick + " (tx " + txHash
            + ") at status=valid")

        let debitRow = requireRow(await indexerDatabase.waitForDebit({
            address: addressInfo["address"],
            tick: tick,
            txHash: txHash,
            amount: amount
        }), "sendDestroyV0: the " + tick + " debit from " + addressInfo["address"]
            + " (tx " + txHash + ")")

        return { txHash, destroy: destroyRow, debit: debitRow }
    },

    async sendDestroyV1(addressInfo, destroys, memo){
        // destroys = [{tick, amount}, {tick, amount}, ...]
        let destroyMessage = "DESTROY|1"
        for (let d of destroys) {
            destroyMessage += "|"+d.tick+"|"+d.amount
        }
        if (memo) destroyMessage += "|"+memo

        console.log("Creating and sending DESTROY V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, destroyMessage)

        // Note: indexer createDestroy uses action_index as unique key, so in a
        // multi-destroy only the last entry survives (overwrites previous ones).
        // We check the last destroy until the indexer adds a composite key.
        let last = destroys[destroys.length - 1]
        console.log("Waiting for DESTROY in the database...")
        let destroyRow = requireRow(await indexerDatabase.waitForDestroy({
            txHash: txHash,
            source: addressInfo["address"],
            tick: last.tick,
            amount: last.amount,
            status: "valid"
        }), "sendDestroyV1: the surviving DESTROY of " + last.amount + " " + last.tick
            + " (tx " + txHash + ") at status=valid")

        return { txHash, destroy: destroyRow }
    },

    async sendDestroyV2(addressInfo, destroys){
        // destroys = [{tick, amount, memo}, {tick, amount, memo}, ...]
        let destroyMessage = "DESTROY|2"
        for (let d of destroys) {
            destroyMessage += "|"+d.tick+"|"+d.amount+"|"+(d.memo || "")
        }

        console.log("Creating and sending DESTROY V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, destroyMessage)

        // Note: same indexer limitation as v1, only last destroy survives.
        let last = destroys[destroys.length - 1]
        console.log("Waiting for DESTROY in the database...")
        let destroyRow = requireRow(await indexerDatabase.waitForDestroy({
            txHash: txHash,
            source: addressInfo["address"],
            tick: last.tick,
            amount: last.amount,
            status: "valid"
        }), "sendDestroyV2: the surviving DESTROY of " + last.amount + " " + last.tick
            + " (tx " + txHash + ") at status=valid")

        return { txHash, destroy: destroyRow }
    }
}
