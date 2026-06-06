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
    async sendSleepV0(addressInfo, resumeBlock, memo){
        let sleepMessage = "SLEEP|0|"+resumeBlock+"|"+memo

        console.log("Creating and sending SLEEP V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sleepMessage)

        console.log("Waiting for SLEEP in the database...")
        let row = await indexerDatabase.waitForSleep({
            txHash: txHash,
            source: addressInfo["address"],
            resumeBlock: resumeBlock,
            status: "valid"
        })

        return { txHash, sleep: row }
    },

    async sendSleepV1(addressInfo, resumeBlock, tick, memo){
        let sleepMessage = "SLEEP|1|"+resumeBlock+"|"+tick+"|"+memo

        console.log("Creating and sending SLEEP V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sleepMessage)

        console.log("Waiting for SLEEP in the database...")
        let row = await indexerDatabase.waitForSleep({
            txHash: txHash,
            source: addressInfo["address"],
            tick: tick,
            resumeBlock: resumeBlock,
            status: "valid"
        })

        return { txHash, sleep: row }
    }
}
