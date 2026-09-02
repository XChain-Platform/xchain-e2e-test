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
    async sendBroadcastV0(addressInfo, message, value){
        let address = addressInfo["address"]
        let broadcastMessage = "BROADCAST|0|"+message+"|"+value

        console.log("Creating and sending BROADCAST V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, broadcastMessage)

        let broadcastRow = requireRow(await indexerDatabase.waitForBroadcast({
            source: address, txHash: txHash, message: message,
            value: value, status: "valid"
        }), "sendBroadcastV0: BROADCAST from " + address + " (tx " + txHash + ") at status=valid")

        return { txHash, broadcast: broadcastRow }
    },

    async sendBroadcastV1(addressInfo, message, value, fee, memo){
        let address = addressInfo["address"]
        let broadcastMessage = "BROADCAST|1|"+message+"|"+value+"|"+fee+"|"+memo

        console.log("Creating and sending BROADCAST V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, broadcastMessage)

        let broadcastRow = requireRow(await indexerDatabase.waitForBroadcast({
            source: address, txHash: txHash, message: message,
            value: value, fee: fee, memo: memo, status: "valid"
        }), "sendBroadcastV1: BROADCAST from " + address + " (tx " + txHash + ") at status=valid")

        return { txHash, broadcast: broadcastRow }
    },

    async sendBroadcastV2(addressInfo, message, fee, memo){
        let address = addressInfo["address"]
        let broadcastMessage = "BROADCAST|2|"+message+"|"+fee+"|"+memo

        console.log("Creating and sending BROADCAST V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, broadcastMessage)

        let broadcastRow = requireRow(await indexerDatabase.waitForBroadcast({
            source: address, txHash: txHash, message: message,
            fee: fee, memo: memo, status: "valid"
        }), "sendBroadcastV2: BROADCAST from " + address + " (tx " + txHash + ") at status=valid")

        return { txHash, broadcast: broadcastRow }
    },

    async sendBroadcastV3(addressInfo, broadcastActionIndex, value, memo){
        let address = addressInfo["address"]
        let broadcastMessage = "BROADCAST|3|"+broadcastActionIndex+"|"+value+"|"+memo

        console.log("Creating and sending BROADCAST V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, broadcastMessage)

        let broadcastRow = requireRow(await indexerDatabase.waitForBroadcast({
            source: address, txHash: txHash, broadcastActionIndex: broadcastActionIndex,
            value: value, memo: memo, status: "valid"
        }), "sendBroadcastV3: BROADCAST update of action " + broadcastActionIndex
            + " (tx " + txHash + ") at status=valid")

        return { txHash, broadcast: broadcastRow }
    }
}
