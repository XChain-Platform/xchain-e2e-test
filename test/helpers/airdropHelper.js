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
    async sendAirdropV0(addressInfo, tick, amount, listActionIndex, memo){
        let address = addressInfo["address"]
        let airdropMessage = "AIRDROP|0|"+tick+"|"+amount+"|"+listActionIndex+"|"+memo

        console.log("Creating and sending AIRDROP V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, airdropMessage)

        let airdropRow = requireRow(await indexerDatabase.waitForAirdrop({
            source: address, txHash: txHash, tick: tick,
            amount: amount, listActionIndex: listActionIndex,
            memo: memo, status: "valid"
        }), "sendAirdropV0: AIRDROP of " + amount + " " + tick + " over list "
            + listActionIndex + " (tx " + txHash + ") at status=valid")

        return { txHash, airdrop: airdropRow }
    },

    async sendAirdropV1(addressInfo, tick1, amount1, tick2, amount2, listActionIndex, memo){
        let address = addressInfo["address"]
        let airdropMessage = "AIRDROP|1|"+listActionIndex+"|"+tick1+"|"+amount1+"|"+tick2+"|"+amount2+"|"+memo

        console.log("Creating and sending AIRDROP V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, airdropMessage)

        let airdropRow1 = requireRow(await indexerDatabase.waitForAirdrop({
            source: address, txHash: txHash, tick: tick1,
            amount: amount1, listActionIndex: listActionIndex,
            memo: memo, status: "valid"
        }), "sendAirdropV1: AIRDROP leg 1 of " + amount1 + " " + tick1 + " over list "
            + listActionIndex + " (tx " + txHash + ") at status=valid")

        let airdropRow2 = requireRow(await indexerDatabase.waitForAirdrop({
            source: address, txHash: txHash, tick: tick2,
            amount: amount2, listActionIndex: listActionIndex,
            status: "valid"
        }), "sendAirdropV1: AIRDROP leg 2 of " + amount2 + " " + tick2 + " over list "
            + listActionIndex + " (tx " + txHash + ") at status=valid")

        return { txHash, airdrop1: airdropRow1, airdrop2: airdropRow2 }
    },

    async sendAirdropV2(addressInfo, tick1, amount1, tick2, amount2, listActionIndex, listActionIndex2, memo){
        let address = addressInfo["address"]
        let airdropMessage = "AIRDROP|2|"+tick1+"|"+amount1+"|"+listActionIndex+"|"+tick2+"|"+amount2+"|"+listActionIndex2+"|"+memo

        console.log("Creating and sending AIRDROP V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, airdropMessage)

        let airdropRow1 = requireRow(await indexerDatabase.waitForAirdrop({
            source: address, txHash: txHash, tick: tick1,
            amount: amount1, listActionIndex: listActionIndex,
            memo: memo, status: "valid"
        }), "sendAirdropV2: AIRDROP leg 1 of " + amount1 + " " + tick1 + " over list "
            + listActionIndex + " (tx " + txHash + ") at status=valid")

        let airdropRow2 = requireRow(await indexerDatabase.waitForAirdrop({
            source: address, txHash: txHash, tick: tick2,
            amount: amount2, listActionIndex: listActionIndex2,
            status: "valid"
        }), "sendAirdropV2: AIRDROP leg 2 of " + amount2 + " " + tick2 + " over list "
            + listActionIndex2 + " (tx " + txHash + ") at status=valid")

        return { txHash, airdrop1: airdropRow1, airdrop2: airdropRow2 }
    },

    async sendAirdropV3(addressInfo, tick1, amount1, tick2, amount2, listActionIndex, listActionIndex2, memo, memo2){
        let address = addressInfo["address"]
        let airdropMessage = "AIRDROP|3|"+tick1+"|"+amount1+"|"+listActionIndex+"|"+memo+"|"+tick2+"|"+amount2+"|"+listActionIndex2+"|"+memo2

        console.log("Creating and sending AIRDROP V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, airdropMessage)

        let airdropRow1 = requireRow(await indexerDatabase.waitForAirdrop({
            source: address, txHash: txHash, tick: tick1,
            amount: amount1, listActionIndex: listActionIndex,
            memo: memo, status: "valid"
        }), "sendAirdropV3: AIRDROP leg 1 of " + amount1 + " " + tick1 + " over list "
            + listActionIndex + " (tx " + txHash + ") at status=valid")

        let airdropRow2 = requireRow(await indexerDatabase.waitForAirdrop({
            source: address, txHash: txHash, tick: tick2,
            amount: amount2, listActionIndex: listActionIndex2,
            memo: memo2, status: "valid"
        }), "sendAirdropV3: AIRDROP leg 2 of " + amount2 + " " + tick2 + " over list "
            + listActionIndex2 + " (tx " + txHash + ") at status=valid")

        return { txHash, airdrop1: airdropRow1, airdrop2: airdropRow2 }
    }
}
