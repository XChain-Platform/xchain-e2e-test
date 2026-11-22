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

function rejectDuplicateLegs(destroys, keyOf, label){
    const seen = new Set()
    for (const d of destroys) {
        const key = keyOf(d)
        if (seen.has(key)) throw new Error(label + ': duplicate destroy leg ' + key)
        seen.add(key)
    }
}

async function waitForLegs(addressInfo, destroys, txHash, label, includeMemo){
    for (let i = 0; i < destroys.length; i++) {
        const d = destroys[i]
        const query = {
            txHash,
            source: addressInfo.address,
            tick: d.tick,
            amount: d.amount,
            status: 'valid'
        }
        if (includeMemo) query.memo = d.memo || ''
        requireRow(await indexerDatabase.waitForDestroy(query), label + ': leg ' + i + ' of '
            + destroys.length + ' (' + d.amount + ' ' + d.tick + ', tx ' + txHash + ') at status=valid')
    }

    const legs = requireRow(await indexerDatabase.waitForDestroyLegs({ txHash, count: destroys.length }),
        label + ': ordered leg set for tx ' + txHash)
    if (legs.length !== destroys.length) {
        throw new Error(label + ': expected ' + destroys.length + ' legs, got ' + legs.length)
    }
    for (let i = 0; i < destroys.length; i++) {
        if (Number(legs[i].leg_ordinal) !== i || legs[i].tick !== destroys[i].tick
            || String(legs[i].amount) !== String(destroys[i].amount)) {
            throw new Error(label + ': leg ' + i + ' does not match wire order')
        }
    }
    return legs
}

module.exports = {
    async sendDestroyV0(addressInfo, tick, amount, memo){
        const destroyMessage = "DESTROY|0|"+tick+"|"+amount+"|"+memo

        console.log("Creating and sending DESTROY V0 tx...")
        const txHash = await transactionHelper.createAndSendTransaction(addressInfo, destroyMessage)

        console.log("Waiting for DESTROY in the database...")
        const destroyRow = requireRow(await indexerDatabase.waitForDestroy({
            txHash: txHash,
            source: addressInfo["address"],
            tick: tick,
            amount: amount,
            status: "valid"
        }), "sendDestroyV0: DESTROY of " + amount + " " + tick + " (tx " + txHash
            + ") at status=valid")

        const debitRow = requireRow(await indexerDatabase.waitForDebit({
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
        rejectDuplicateLegs(destroys, d => String(d.tick), 'sendDestroyV1')
        let destroyMessage = "DESTROY|1"
        for (const d of destroys) {
            destroyMessage += "|"+d.tick+"|"+d.amount
        }
        if (memo) destroyMessage += "|"+memo

        console.log("Creating and sending DESTROY V1 tx...")
        const txHash = await transactionHelper.createAndSendTransaction(addressInfo, destroyMessage)

        console.log("Waiting for DESTROY in the database...")
        const rows = await waitForLegs(addressInfo, destroys, txHash, 'sendDestroyV1', false)

        return { txHash, destroy: rows[rows.length - 1], destroys: rows }
    },

    async sendDestroyV2(addressInfo, destroys){
        // destroys = [{tick, amount, memo}, {tick, amount, memo}, ...]
        rejectDuplicateLegs(destroys, d => String(d.tick) + '|' + String(d.memo || ''), 'sendDestroyV2')
        let destroyMessage = "DESTROY|2"
        for (const d of destroys) {
            destroyMessage += "|"+d.tick+"|"+d.amount+"|"+(d.memo || "")
        }

        console.log("Creating and sending DESTROY V2 tx...")
        const txHash = await transactionHelper.createAndSendTransaction(addressInfo, destroyMessage)

        console.log("Waiting for DESTROY in the database...")
        const rows = await waitForLegs(addressInfo, destroys, txHash, 'sendDestroyV2', true)

        return { txHash, destroy: rows[rows.length - 1], destroys: rows }
    }
}
