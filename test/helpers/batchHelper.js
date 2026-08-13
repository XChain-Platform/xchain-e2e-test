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
    },

    // Additive sibling of sendBatchV0, for the cases sendBatchV0 cannot express.
    //
    // sendBatchV0 hard-codes a wait for status 'valid', so it can neither send a
    // deliberately INVALID batch (every limit/cap case) nor attach a hand-sized
    // native-coin fee output (every batch-cumulative fee case, where the whole point
    // is that the output covers exactly one command's worth). Both are additive here
    // rather than new arguments on sendBatchV0, because other suites call that one.
    //
    // opts:
    //   version                 BATCH format version (default 0)
    //   status                  status to wait for (default 'valid'); pass null to
    //                           send and return immediately without waiting
    //   customOutputs           extra transaction outputs (e.g. an exact-size fee output)
    //   skipNativeFeeInjection  true to suppress transactionHelper's automatic
    //                           native-fee output on LTC/DOGE
    //   timeout                 wait budget in ms (default 120000; a 250-command batch
    //                           is a lot of indexer work for one block)
    async sendBatch(addressInfo, commands, opts = {}){
        let version = (opts.version === undefined || opts.version === null) ? 0 : opts.version
        let batchMessage = "BATCH|"+version+"|"+commands.join(";")

        console.log("Creating and sending BATCH v"+version+" tx ("+commands.length+" commands)...")
        let txHash = await transactionHelper.createAndSendTransaction(
            addressInfo,
            batchMessage,
            null,
            opts.customOutputs || [],
            null,
            null,
            opts.skipNativeFeeInjection === true
        )

        let row = null
        if (opts.status !== null){
            let status = opts.status || 'valid'
            console.log("Waiting for BATCH ("+status+") in the database...")
            row = await indexerDatabase.waitForBatch({
                txHash: txHash,
                source: addressInfo["address"],
                status: status
            }, opts.timeout || 120000)
        }

        return { txHash, batch: row }
    }
}
