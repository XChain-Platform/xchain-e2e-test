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
    async sendSendV0(addressInfo, tick, amount, destination, memo){
        let address = addressInfo["address"]
        let sendMessage = "SEND|0|"+tick+"|"+amount+"|"+destination+"|"+memo

        console.log("Creating and sending SEND V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sendMessage)

        console.log("Waiting for SEND in the database...")
        let sendRow = requireRow(await indexerDatabase.waitForSend({
            source: address,
            destination: destination,
            tick: tick,
            amount: amount,
            txHash: txHash,
            memo: memo,
            status: "valid"
        }), "sendSendV0: SEND " + amount + " " + tick + " to " + destination
            + " (tx " + txHash + ") at status=valid")

        let creditRow = requireRow(await indexerDatabase.waitForCredit({
            address: destination,
            tick: tick,
            txHash: txHash,
            amount: amount
        }), "sendSendV0: the " + tick + " credit to " + destination + " (tx " + txHash + ")")

        let debitRow = requireRow(await indexerDatabase.waitForDebit({
            address: address,
            tick: tick,
            txHash: txHash,
            amount: amount
        }), "sendSendV0: the " + tick + " debit from " + address + " (tx " + txHash + ")")

        return { txHash, send: sendRow, credit: creditRow, debit: debitRow }
    },

    async sendSendV1(addressInfo, tick, amount1, destination1, amount2, destination2, memo){
        let address = addressInfo["address"]
        let sendMessage = "SEND|1|"+tick+"|"+amount1+"|"+destination1+"|"+amount2+"|"+destination2+"|"+memo

        console.log("Creating and sending SEND V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sendMessage)

        let send1Row = requireRow(await indexerDatabase.waitForSend({
            source: address, destination: destination1, tick: tick,
            amount: amount1, txHash: txHash, memo: memo, status: "valid"
        }), "sendSendV1: SEND leg 1 of " + amount1 + " " + tick + " to " + destination1
            + " (tx " + txHash + ") at status=valid")
        let send2Row = requireRow(await indexerDatabase.waitForSend({
            source: address, destination: destination2, tick: tick,
            amount: amount2, txHash: txHash, memo: memo, status: "valid"
        }), "sendSendV1: SEND leg 2 of " + amount2 + " " + tick + " to " + destination2
            + " (tx " + txHash + ") at status=valid")
        let credit1Row = requireRow(await indexerDatabase.waitForCredit({
            address: destination1, tick: tick, txHash: txHash, amount: amount1
        }), "sendSendV1: the " + tick + " credit to " + destination1 + " (tx " + txHash + ")")
        let credit2Row = requireRow(await indexerDatabase.waitForCredit({
            address: destination2, tick: tick, txHash: txHash, amount: amount2
        }), "sendSendV1: the " + tick + " credit to " + destination2 + " (tx " + txHash + ")")
        let debitRow = requireRow(await indexerDatabase.waitForDebit({
            address: address, tick: tick, txHash: txHash, amount: amount1 + amount2
        }), "sendSendV1: the combined " + tick + " debit from " + address + " (tx " + txHash + ")")

        return { txHash, send1: send1Row, send2: send2Row, credit1: credit1Row, credit2: credit2Row, debit: debitRow }
    },

    async sendSendV2(addressInfo, tick1, amount1, destination1, tick2, amount2, destination2, memo){
        let address = addressInfo["address"]
        let sendMessage = "SEND|2|"+tick1+"|"+amount1+"|"+destination1+"|"+tick2+"|"+amount2+"|"+destination2+"|"+memo

        console.log("Creating and sending SEND V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sendMessage)

        let send1Row = requireRow(await indexerDatabase.waitForSend({
            source: address, destination: destination1, tick: tick1,
            amount: amount1, txHash: txHash, memo: memo, status: "valid"
        }), "sendSendV2: SEND leg 1 of " + amount1 + " " + tick1 + " to " + destination1
            + " (tx " + txHash + ") at status=valid")
        let send2Row = requireRow(await indexerDatabase.waitForSend({
            source: address, destination: destination2, tick: tick2,
            amount: amount2, txHash: txHash, memo: memo, status: "valid"
        }), "sendSendV2: SEND leg 2 of " + amount2 + " " + tick2 + " to " + destination2
            + " (tx " + txHash + ") at status=valid")
        let credit1Row = requireRow(await indexerDatabase.waitForCredit({
            address: destination1, tick: tick1, txHash: txHash, amount: amount1
        }), "sendSendV2: the " + tick1 + " credit to " + destination1 + " (tx " + txHash + ")")
        let credit2Row = requireRow(await indexerDatabase.waitForCredit({
            address: destination2, tick: tick2, txHash: txHash, amount: amount2
        }), "sendSendV2: the " + tick2 + " credit to " + destination2 + " (tx " + txHash + ")")
        let debit1Row = requireRow(await indexerDatabase.waitForDebit({
            address: address, tick: tick1, txHash: txHash, amount: amount1
        }), "sendSendV2: the " + tick1 + " debit from " + address + " (tx " + txHash + ")")
        let debit2Row = requireRow(await indexerDatabase.waitForDebit({
            address: address, tick: tick2, txHash: txHash, amount: amount2
        }), "sendSendV2: the " + tick2 + " debit from " + address + " (tx " + txHash + ")")

        return { txHash, send1: send1Row, send2: send2Row, credit1: credit1Row, credit2: credit2Row, debit1: debit1Row, debit2: debit2Row }
    },

    async sendSendV3(addressInfo, tick1, amount1, destination1, memo1, tick2, amount2, destination2, memo2){
        let address = addressInfo["address"]
        let sendMessage = "SEND|3|"+tick1+"|"+amount1+"|"+destination1+"|"+memo1+"|"+tick2+"|"+amount2+"|"+destination2+"|"+memo2

        console.log("Creating and sending SEND V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sendMessage)

        let send1Row = requireRow(await indexerDatabase.waitForSend({
            source: address, destination: destination1, tick: tick1,
            amount: amount1, txHash: txHash, memo: memo1, status: "valid"
        }), "sendSendV3: SEND leg 1 of " + amount1 + " " + tick1 + " to " + destination1
            + " (tx " + txHash + ") at status=valid")
        let send2Row = requireRow(await indexerDatabase.waitForSend({
            source: address, destination: destination2, tick: tick2,
            amount: amount2, txHash: txHash, memo: memo2, status: "valid"
        }), "sendSendV3: SEND leg 2 of " + amount2 + " " + tick2 + " to " + destination2
            + " (tx " + txHash + ") at status=valid")
        let credit1Row = requireRow(await indexerDatabase.waitForCredit({
            address: destination1, tick: tick1, txHash: txHash, amount: amount1
        }), "sendSendV3: the " + tick1 + " credit to " + destination1 + " (tx " + txHash + ")")
        let credit2Row = requireRow(await indexerDatabase.waitForCredit({
            address: destination2, tick: tick2, txHash: txHash, amount: amount2
        }), "sendSendV3: the " + tick2 + " credit to " + destination2 + " (tx " + txHash + ")")
        let debit1Row = requireRow(await indexerDatabase.waitForDebit({
            address: address, tick: tick1, txHash: txHash, amount: amount1
        }), "sendSendV3: the " + tick1 + " debit from " + address + " (tx " + txHash + ")")
        let debit2Row = requireRow(await indexerDatabase.waitForDebit({
            address: address, tick: tick2, txHash: txHash, amount: amount2
        }), "sendSendV3: the " + tick2 + " debit from " + address + " (tx " + txHash + ")")

        return { txHash, send1: send1Row, send2: send2Row, credit1: credit1Row, credit2: credit2Row, debit1: debit1Row, debit2: debit2Row }
    }
}
