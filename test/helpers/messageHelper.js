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
    // MESSAGE wire format: MESSAGE|VERSION|COIN|DESTINATION|...
    async sendMessageV3(addressInfo, destination, plaintextMessage){
        let messageStr = "MESSAGE|3|"+COIN_CODE+"|"+destination+"|"+plaintextMessage

        console.log("Creating and sending MESSAGE V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, messageStr)

        console.log("Waiting for MESSAGE in the database...")
        let row = await indexerDatabase.waitForMessage({
            txHash: txHash,
            source: addressInfo["address"],
            destination: destination,
            plaintextMessage: plaintextMessage,
            status: "valid"
        })

        return { txHash, message: row }
    },

    async sendMessageV0(addressInfo, destination, encryptionMethod, encryptionKey){
        let messageStr = "MESSAGE|0|"+COIN_CODE+"|"+destination+"|"+encryptionMethod+"|"+encryptionKey

        console.log("Creating and sending MESSAGE V0 (sender key) tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, messageStr)

        console.log("Waiting for MESSAGE in the database...")
        let row = await indexerDatabase.waitForMessage({
            txHash: txHash,
            source: addressInfo["address"],
            destination: destination,
            encryptionMethod: encryptionMethod,
            status: "valid"
        })

        return { txHash, message: row }
    },

    async sendMessageV1(addressInfo, destination, encryptionMethod, encryptionKey){
        let messageStr = "MESSAGE|1|"+COIN_CODE+"|"+destination+"|"+encryptionMethod+"|"+encryptionKey

        console.log("Creating and sending MESSAGE V1 (receiver key) tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, messageStr)

        console.log("Waiting for MESSAGE in the database...")
        let row = await indexerDatabase.waitForMessage({
            txHash: txHash,
            source: addressInfo["address"],
            destination: destination,
            encryptionMethod: encryptionMethod,
            status: "valid"
        })

        return { txHash, message: row }
    },

    async sendMessageV2(addressInfo, destination, encryptedMessage){
        let messageStr = "MESSAGE|2|"+COIN_CODE+"|"+destination+"|"+encryptedMessage

        console.log("Creating and sending MESSAGE V2 (encrypted) tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, messageStr)

        console.log("Waiting for MESSAGE in the database...")
        let row = await indexerDatabase.waitForMessage({
            txHash: txHash,
            source: addressInfo["address"],
            destination: destination,
            status: "valid"
        })

        return { txHash, message: row }
    }
}
