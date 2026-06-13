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

// Poll until a stake/unstake row with the given txHash appears (any status).
// Used by negative-path tests that need to read back an invalid-status row.
async function waitForAnyStake({source, signingPubkey, txHash}, timeMax = 60000){
    const startMs = Date.now(), endTime = startMs + timeMax
    while(Date.now() < endTime){
        let row = await indexerDatabase.checkStake({source, signingPubkey, txHash}).catch(() => null)
        if(row) return row
        await new Promise(r => setTimeout(r, 1000))
    }
    return null
}

async function waitForAnyUnstake({source, signingPubkey, txHash}, timeMax = 60000){
    const startMs = Date.now(), endTime = startMs + timeMax
    while(Date.now() < endTime){
        let row = await indexerDatabase.checkUnstake({source, signingPubkey, txHash}).catch(() => null)
        if(row) return row
        await new Promise(r => setTimeout(r, 1000))
    }
    return null
}

async function waitForAnyDelegation({source, txHash}, timeMax = 60000){
    const startMs = Date.now(), endTime = startMs + timeMax
    while(Date.now() < endTime){
        let row = await indexerDatabase.checkDelegation({source, txHash}).catch(() => null)
        if(row) return row
        await new Promise(r => setTimeout(r, 1000))
    }
    return null
}

module.exports = {
    // Negative-path helpers — return the row regardless of status so the
    // test can assert against the specific rejection reason.
    waitForAnyStake,
    waitForAnyUnstake,
    waitForAnyDelegation,
    // STAKE v1 — create a new stake (capability model: capabilities auto-qualify by amount).
    // See claude/reports/specs/2026-05-24_capability-staking-model.md
    async sendStakeV1(addressInfo, amount, signingPubkey){
        let address = addressInfo["address"]
        let msg = "STAKE|1|" + amount + "|" + signingPubkey

        console.log("Creating and sending STAKE V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for stake in the database...")
        let stakeRow = await indexerDatabase.waitForStake({
            source:        address,
            signingPubkey: signingPubkey,
            txHash:        txHash,
            status:        "valid"
        })

        return { txHash, stake: stakeRow }
    },

    // STAKE v2 — top up an existing stake (same pubkey, same source)
    async sendStakeV2(addressInfo, amount, signingPubkey){
        let address = addressInfo["address"]
        let msg = "STAKE|2|" + amount + "|" + signingPubkey

        console.log("Creating and sending STAKE V2 (top-up) tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for top-up stake row in the database...")
        let stakeRow = await indexerDatabase.waitForStake({
            source:        address,
            signingPubkey: signingPubkey,
            txHash:        txHash,
            status:        "valid"
        })

        return { txHash, stake: stakeRow }
    },

    // UNSTAKE v0 — begin cooldown for a stake identified by pubkey
    async sendUnstakeV0(addressInfo, signingPubkey){
        let address = addressInfo["address"]
        let msg = "UNSTAKE|0|" + signingPubkey

        console.log("Creating and sending UNSTAKE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for unstake in the database...")
        let unstakeRow = await indexerDatabase.waitForUnstake({
            source:        address,
            signingPubkey: signingPubkey,
            txHash:        txHash,
            status:        "valid"
        })

        return { txHash, unstake: unstakeRow }
    },

    async sendDelegateV0(addressInfo, newSigningPubkey){
        let address = addressInfo["address"]
        let msg = "DELEGATE|0|" + newSigningPubkey

        console.log("Creating and sending DELEGATE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for delegation in the database...")
        let delegationRow = await indexerDatabase.waitForDelegation({
            source: address,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, delegation: delegationRow }
    },

    async sendRevokeDelegationV0(addressInfo, signingPubkey){
        let address = addressInfo["address"]
        // Capability revoke is now DELEGATE v2 (wire) — same single-param shape
        let msg = "DELEGATE|2|" + signingPubkey

        console.log("Creating and sending DELEGATE v2 (capability revoke) tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for revocation in the database...")
        let revocationRow = await indexerDatabase.waitForDelegation({
            source: address,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, revocation: revocationRow }
    },

    // DELEGATE v2 against the source's ORIGINAL stake signing key — the
    // key-compromise completion path. Recorded ONLY in stake_key_revocations
    // (NOT delegations), so it waits on the dedicated revocations checker.
    async sendStakeKeyRevoke(addressInfo, signingPubkey){
        let address = addressInfo["address"]
        let msg = "DELEGATE|2|" + signingPubkey

        console.log("Creating and sending DELEGATE v2 (stake-key revoke) tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for stake-key revocation in the database...")
        let revocationRow = await indexerDatabase.waitForStakeKeyRevocation({
            source:        address,
            signingPubkey: signingPubkey,
            txHash:        txHash,
            status:        "valid"
        })

        return { txHash, revocation: revocationRow }
    },

    // DELEGATE expected to be REJECTED (any version that records its rejection
    // in the delegations table — v0 collisions, v2 double-revokes). Broadcasts
    // and polls the row status-agnostically so the test can assert the reason.
    async sendDelegateInvalid(addressInfo, version, signingPubkey){
        let address = addressInfo["address"]
        let msg = "DELEGATE|" + version + "|" + signingPubkey

        console.log("Creating and sending (expected-invalid) DELEGATE v" + version + " tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for the rejected delegations row in the database...")
        let row = await waitForAnyDelegation({ source: address, txHash: txHash })

        return { txHash, delegation: row }
    },

    async sendCollectV0(addressInfo){
        let address = addressInfo["address"]
        let msg = "COLLECT|0"

        console.log("Creating and sending COLLECT V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for reward claim in the database...")
        let claimRow = await indexerDatabase.waitForRewardClaim({
            source: address,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, claim: claimRow }
    },

    // STAKE v3 — contract-targeted stake (any tick). The contract must have been
    // deployed with cooldown_blocks + slash_destination set (DEPLOY v1+).
    async sendStakeV3(addressInfo, amount, signingPubkey, contractIndex, tick){
        let address = addressInfo["address"]
        let msg = "STAKE|3|" + amount + "|" + signingPubkey + "|" + contractIndex + "|" + tick

        console.log("Creating and sending STAKE V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for contract stake in the database...")
        let stakeRow = await indexerDatabase.waitForContractStake({
            source:         address,
            signingPubkey:  signingPubkey,
            contractIndex:  contractIndex,
            tick:           tick,
            txHash:         txHash,
            status:         "valid"
        })

        return { txHash, stake: stakeRow }
    },

    // STAKE v3 expected to be REJECTED. The valid-only waitForContractStake can never
    // observe an intentionally-invalid stake, so broadcast and poll the row
    // status-agnostically (invalid contract stakes still write a contract_stakes row
    // carrying the rejection status — see xchain-indexer stake.js _parseContractStake,
    // which calls createContractStake unconditionally). Filters on the unique
    // (source, pubkey, target, tick) tuple — not txHash — so it stays robust to encoding.
    async sendStakeV3Invalid(addressInfo, amount, signingPubkey, contractIndex, tick, timeMax = 60000){
        let address = addressInfo["address"]
        let msg = "STAKE|3|" + amount + "|" + signingPubkey + "|" + contractIndex + "|" + tick

        console.log("Creating and sending (expected-invalid) STAKE V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for the rejected contract_stakes row in the database...")
        let end = Date.now() + timeMax
        let row = null
        while(Date.now() < end){
            row = await indexerDatabase.checkContractStake({
                source:        address,
                signingPubkey: signingPubkey,
                contractIndex: contractIndex,
                tick:          tick
            }).catch(() => null)
            if(row) break
            await new Promise(r => setTimeout(r, 1000))
        }

        return { txHash, stake: row }
    },

    // UNSTAKE v1 — begin cooldown for a contract-targeted stake
    async sendUnstakeV1(addressInfo, signingPubkey, contractIndex, tick){
        let address = addressInfo["address"]
        let msg = "UNSTAKE|1|" + signingPubkey + "|" + contractIndex + "|" + tick

        console.log("Creating and sending UNSTAKE V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for contract unstake in the database...")
        let unstakeRow = await indexerDatabase.waitForContractUnstake({
            source:        address,
            signingPubkey: signingPubkey,
            contractIndex: contractIndex,
            tick:          tick,
            txHash:        txHash,
            status:        "valid"
        })

        return { txHash, unstake: unstakeRow }
    },

    // DELEGATE v1 — rotate signing key for a contract-targeted stake
    async sendDelegateV1(addressInfo, newSigningPubkey, contractIndex, tick){
        let address = addressInfo["address"]
        let msg = "DELEGATE|1|" + newSigningPubkey + "|" + contractIndex + "|" + tick

        console.log("Creating and sending DELEGATE V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for contract delegation in the database...")
        let delegationRow = await indexerDatabase.waitForContractDelegation({
            source:        address,
            contractIndex: contractIndex,
            tick:          tick,
            txHash:        txHash,
            status:        "valid"
        })

        return { txHash, delegation: delegationRow }
    }
}
