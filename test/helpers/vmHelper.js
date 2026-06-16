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
    async sendDeployV0(addressInfo, code, gasLimit, constructorParams){
        let address = addressInfo["address"]
        let codeB64 = Buffer.from(code, 'utf8').toString('base64')
        let msg = "DEPLOY|0|" + codeB64 + "|" + gasLimit
        if(constructorParams) msg += "|" + constructorParams

        console.log("Creating and sending DEPLOY V0 tx...")
        // DEPLOY carries the full contract bytecode (base64-encoded) which can exceed
        // OP_RETURN limits — force P2SH (the helper supports its 2-tx finalizer).
        // Auto-selected P2WSH encoding hits "Not finalized" because the helper's
        // PSBT signing path only handles legacy P2PKH inputs + the P2SH finalizer.
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg, null, [], "P2SH")

        console.log("Waiting for contract in the database...")
        let contractRow = await indexerDatabase.waitForContract({
            source: address,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, contract: contractRow }
    },

    // DEPLOY v1 — stakeable contract. cooldownBlocks + slashDestination are required for the
    // contract to accept STAKE v3. slashDestination may be the string 'BURN' to route slashed
    // funds to the chain's burn address. Pass an empty string for constructorParams to skip.
    async sendDeployV1(addressInfo, code, gasLimit, constructorParams, cooldownBlocks, slashDestination){
        let address = addressInfo["address"]
        let codeB64 = Buffer.from(code, 'utf8').toString('base64')
        let msg = "DEPLOY|1|" + codeB64 + "|" + gasLimit + "|" + (constructorParams || '')
                  + "|" + cooldownBlocks + "|" + (slashDestination || '')

        console.log("Creating and sending DEPLOY V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg, null, [], "P2SH")

        console.log("Waiting for stakeable contract in the database...")
        let contractRow = await indexerDatabase.waitForContract({
            source: address,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, contract: contractRow }
    },

    // DEPLOY v1 expected to be REJECTED. The valid-only waitForContract can never observe an
    // intentionally-invalid deploy, so broadcast and poll the contract row status-agnostically
    // (invalid deploys still write a contracts row, carrying the rejection status).
    async sendDeployV1Invalid(addressInfo, code, gasLimit, constructorParams, cooldownBlocks, slashDestination){
        let address = addressInfo["address"]
        let codeB64 = Buffer.from(code, 'utf8').toString('base64')
        let msg = "DEPLOY|1|" + codeB64 + "|" + gasLimit + "|" + (constructorParams || '')
                  + "|" + cooldownBlocks + "|" + (slashDestination || '')

        console.log("Creating and sending (expected-invalid) DEPLOY V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg, null, [], "P2SH")

        console.log("Waiting for the rejected contract row in the database...")
        let end = Date.now() + 60000
        let row = null
        while(Date.now() < end){
            row = await indexerDatabase.checkContract({ source: address })
            if(row) break
            await new Promise(r => setTimeout(r, 1000))
        }

        return { txHash, contract: row }
    },

    async sendExecuteV0(addressInfo, contractActionIndex, method, params){
        let address = addressInfo["address"]
        let msg = "EXECUTE|0|" + contractActionIndex + "|" + method
        if(params && params.length > 0) msg += "|" + params.join("|")

        console.log("Creating and sending EXECUTE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for execution in the database...")
        // For P2SH-encoded txes the broadcast txid returned by sendrawtransaction
        // does not match the on-chain hash recorded in index_transactions, so
        // the strict txHash filter either catches the row on the first poll or
        // never matches at all — give it a short window, then fall back to a
        // no-txHash search using the remaining (contract, caller, method) tuple.
        let executionRow = await indexerDatabase.waitForExecution({
            contractIndex: contractActionIndex,
            caller: address,
            methodName: method,
            txHash: txHash,
            status: "valid"
        }, 5000)
        if(!executionRow){
            executionRow = await indexerDatabase.waitForExecution({
                contractIndex: contractActionIndex,
                caller: address,
                methodName: method,
                status: "valid"
            }, 55000)
        }

        return { txHash, execution: executionRow }
    },

    // EXECUTE expected to FAIL (reverted / rejected emission). The valid-only
    // waitForExecution can never observe a failed execution, so broadcast and poll the
    // row status-agnostically on (contract, caller, method) — mirrors sendDeployV1Invalid.
    async sendExecuteV0Invalid(addressInfo, contractActionIndex, method, params, timeMax = 40000){
        let address = addressInfo["address"]
        let msg = "EXECUTE|0|" + contractActionIndex + "|" + method
        if(params && params.length > 0) msg += "|" + params.join("|")

        console.log("Creating and sending (expected-failed) EXECUTE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for the failed execution row in the database...")
        let end = Date.now() + timeMax
        let row = null
        while(Date.now() < end){
            row = await indexerDatabase.checkExecution({
                contractIndex: contractActionIndex,
                caller:        address,
                methodName:    method
            }).catch(() => null)
            if(row) break
            await new Promise(r => setTimeout(r, 1000))
        }

        return { txHash, execution: row }
    },

    async sendDepositV0(addressInfo, contractActionIndex, tick, quantity){
        let address = addressInfo["address"]
        let msg = "DEPOSIT|0|" + contractActionIndex + "|" + tick + "|" + quantity

        console.log("Creating and sending DEPOSIT V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for deposit in the database...")
        let depositRow = await indexerDatabase.waitForDeposit({
            source: address,
            contractIndex: contractActionIndex,
            tick: tick,
            amount: quantity,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, deposit: depositRow }
    },

    async sendWithdrawV0(addressInfo, contractActionIndex, tick, quantity){
        let address = addressInfo["address"]
        let msg = "WITHDRAW|0|" + contractActionIndex + "|" + tick + "|" + quantity

        console.log("Creating and sending WITHDRAW V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for withdrawal in the database...")
        let withdrawalRow = await indexerDatabase.waitForWithdrawal({
            source: address,
            contractIndex: contractActionIndex,
            tick: tick,
            amount: quantity,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, withdrawal: withdrawalRow }
    }
}
