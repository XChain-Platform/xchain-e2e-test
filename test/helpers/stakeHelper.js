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
const stakeTeardown = require('./stakeTeardown')
const requireRow = require('./requireRow')

// Blocks to mine after a STAKE before that stake can be SELECTED into an
// attestation request's responsible set.
//
// Two delays compose here, and mining only the first is the trap: the stake becomes
// ACTIVE at stakeBlock + ACTIVATION_DELAY_BLOCKS (6 on BTC), but
// _computeResponsibleSet resolves the capability snapshot at the REQUEST's block
// BURIED by CANONICAL_REORG_BUFFER (another 6; xchain-indexer
// snapshot_reorg_buffer.js), matching where the hub's CapabilitySnapshot resolves it.
// So a request at height H sees only stakes active at H-6, and the first height that
// can select a stake landing at S is S+6+6.
//
// Getting this wrong does not fail softly. An attestation request whose responsible
// set is smaller than its REDUNDANCY is REJECTED at admission, the rejected emission
// throws, and the EXECUTE that emitted it rolls back to a failed status - so the
// visible symptom is an EXECUTE with no valid execution row, nowhere near the stake.
const ATTESTATION_STAKE_VISIBLE_BLOCKS = 14 // 6 activation + 6 burial + 2 margin

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

// Poll until a reward_claims row with the given txHash appears (any status).
// COLLECT writes a reward_claims row even when it is rejected (createRewardClaim
// runs unconditionally in xchain-indexer/src/actions/collect.js), so negative-path
// tests read the row back status-agnostically and assert the rejection reason.
async function waitForAnyRewardClaim({source, txHash}, timeMax = 60000){
    const startMs = Date.now(), endTime = startMs + timeMax
    while(Date.now() < endTime){
        let row = await indexerDatabase.checkRewardClaim({source, txHash}).catch(() => null)
        if(row) return row
        await new Promise(r => setTimeout(r, 1000))
    }
    return null
}

module.exports = {
    ATTESTATION_STAKE_VISIBLE_BLOCKS,
    // Negative-path helpers: return the row regardless of status so the
    // test can assert against the specific rejection reason.
    waitForAnyStake,
    waitForAnyUnstake,
    waitForAnyDelegation,
    waitForAnyRewardClaim,
    // STAKE v1: create a new stake (capability model: capabilities auto-qualify by amount).
    async sendStakeV1(addressInfo, amount, signingPubkey){
        let address = addressInfo["address"]
        let msg = "STAKE|1|" + amount + "|" + signingPubkey

        console.log("Creating and sending STAKE V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for stake in the database...")
        let stakeRow = requireRow(await indexerDatabase.waitForStake({
            source:        address,
            signingPubkey: signingPubkey,
            txHash:        txHash,
            status:        "valid"
        }), "sendStakeV1: STAKE of " + amount + " by " + address + " (tx " + txHash
            + ") at status=valid")

        // The stake is now a REAL member of the venue's capability sets. Book the
        // debt so the run's teardown gives it back (see stakeTeardown.js).
        stakeTeardown.registerStake({ addressInfo, signingPubkey, amount })

        return { txHash, stake: stakeRow }
    },

    // STAKE v2: top up an existing stake (same pubkey, same source)
    async sendStakeV2(addressInfo, amount, signingPubkey){
        let address = addressInfo["address"]
        let msg = "STAKE|2|" + amount + "|" + signingPubkey

        console.log("Creating and sending STAKE V2 (top-up) tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for top-up stake row in the database...")
        let stakeRow = requireRow(await indexerDatabase.waitForStake({
            source:        address,
            signingPubkey: signingPubkey,
            txHash:        txHash,
            status:        "valid"
        }), "sendStakeV2: the STAKE top-up of " + amount + " by " + address
            + " (tx " + txHash + ") at status=valid")

        // A top-up onto a stake this run already released (or one seeded before
        // it) is still this run's debt: the single UNSTAKE sweeps every row.
        stakeTeardown.registerStake({ addressInfo, signingPubkey, amount })

        return { txHash, stake: stakeRow }
    },

    // UNSTAKE v0: begin cooldown for a stake identified by pubkey.
    // Optional trailing `amount` (partial unstake): omitted = full sweep.
    async sendUnstakeV0(addressInfo, signingPubkey, amount){
        let address = addressInfo["address"]
        let msg = "UNSTAKE|0|" + signingPubkey
        if(amount !== undefined && amount !== null)
            msg += "|" + amount

        console.log("Creating and sending UNSTAKE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for unstake in the database...")
        let unstakeRow = requireRow(await indexerDatabase.waitForUnstake({
            source:        address,
            signingPubkey: signingPubkey,
            txHash:        txHash,
            status:        "valid"
        }), "sendUnstakeV0: UNSTAKE by " + address + " (tx " + txHash + ") at status=valid")

        // Debt discharged, but only for a FULL sweep: a partial UNSTAKE re-stakes
        // the residual, so the pubkey is still a member and still owed back.
        stakeTeardown.noteUnstake({ signingPubkey, amount })

        return { txHash, unstake: unstakeRow }
    },

    async sendDelegateV0(addressInfo, newSigningPubkey){
        let address = addressInfo["address"]
        let msg = "DELEGATE|0|" + newSigningPubkey

        console.log("Creating and sending DELEGATE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for delegation in the database...")
        let delegationRow = requireRow(await indexerDatabase.waitForDelegation({
            source: address,
            txHash: txHash,
            status: "valid"
        }), "sendDelegateV0: DELEGATE by " + address + " (tx " + txHash + ") at status=valid")

        return { txHash, delegation: delegationRow }
    },

    // DELEGATE v2 against an ACTIVE DELEGATION: revoke the delegated key.
    //
    // Under DEL-1 (DELEGATE_REVOKE_NO_REINSERT, armed from genesis on regtest) this
    // writes NO row of its own; it only stamps deactivation_block on the PARENT
    // delegations row. The legacy path inserted a fresh status=valid,
    // activation_block=0 row, which is exactly what DEL-1 removed, so waiting on the
    // revoke's own txHash waits for a row that is never written. The
    // observable is the parent going deactivated, and `deactivation_block` on it is
    // the height the key actually leaves the effective set.
    async sendRevokeDelegationV0(addressInfo, signingPubkey){
        let address = addressInfo["address"]
        // Capability revoke is now DELEGATE v2 (wire); same single-param shape
        let msg = "DELEGATE|2|" + signingPubkey

        console.log("Creating and sending DELEGATE v2 (capability revoke) tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for the parent delegation to go deactivated...")
        let revocationRow = requireRow(await indexerDatabase.waitForDelegation({
            source:        address,
            signingPubkey: signingPubkey,
            status:        "valid",
            deactivated:   true
        }), "sendRevokeDelegationV0: the parent delegation for " + address
            + " going deactivated (tx " + txHash + ")")

        return { txHash, revocation: revocationRow }
    },

    // The delegations row for (source, pubkey), newest first, whatever its state.
    // Lets a negative-path test assert that a REFUSED revoke changed nothing,
    // which is the only observable it has: a refused DELEGATE v2 writes no row at
    // all under DEL-1, so there is no rejection status to read back.
    async readDelegation(addressInfo, signingPubkey){
        return indexerDatabase.checkDelegation({
            source:        addressInfo["address"],
            signingPubkey: signingPubkey
        }).catch(() => null)
    },

    // DELEGATE v2 against the source's ORIGINAL stake signing key:
    // key-compromise completion path. Recorded ONLY in stake_key_revocations
    // (NOT delegations), so it waits on the dedicated revocations checker.
    async sendStakeKeyRevoke(addressInfo, signingPubkey){
        let address = addressInfo["address"]
        let msg = "DELEGATE|2|" + signingPubkey

        console.log("Creating and sending DELEGATE v2 (stake-key revoke) tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for stake-key revocation in the database...")
        let revocationRow = requireRow(await indexerDatabase.waitForStakeKeyRevocation({
            source:        address,
            signingPubkey: signingPubkey,
            txHash:        txHash,
            status:        "valid"
        }), "sendStakeKeyRevoke: the stake-key revocation for " + address
            + " (tx " + txHash + ") at status=valid")

        return { txHash, revocation: revocationRow }
    },

    // DELEGATE expected to be REJECTED, for the versions that still record their
    // rejection in the delegations table: v0 collisions. Broadcasts and polls the
    // row status-agnostically so the test can assert the reason. NOT usable for a
    // v2 revoke: under DEL-1 a refused revoke writes no row anywhere, so there is
    // nothing to poll for and the test must assert the no-op instead.
    async sendDelegateInvalid(addressInfo, version, signingPubkey){
        let address = addressInfo["address"]
        let msg = "DELEGATE|" + version + "|" + signingPubkey

        console.log("Creating and sending (expected-invalid) DELEGATE v" + version + " tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for the rejected delegations row in the database...")
        let row = await waitForAnyDelegation({ source: address, txHash: txHash })

        return { txHash, delegation: row }
    },

    // COLLECT v0: claim accrued validator rewards.
    // Optional trailing `amount` (partial claim): omitted = claim the full total.
    async sendCollectV0(addressInfo, amount){
        let address = addressInfo["address"]
        let msg = "COLLECT|0"
        if(amount !== undefined && amount !== null)
            msg += "|" + amount

        console.log("Creating and sending COLLECT V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for reward claim in the database...")
        let claimRow = requireRow(await indexerDatabase.waitForRewardClaim({
            source: address,
            txHash: txHash,
            status: "valid"
        }), "sendCollectV0: the COLLECT reward claim by " + address + " (tx " + txHash
            + ") at status=valid")

        return { txHash, claim: claimRow }
    },

    // COLLECT v0 expected to be REJECTED. The valid-only waitForRewardClaim can never
    // observe an intentionally-invalid claim, so broadcast and poll the reward_claims
    // row status-agnostically (a rejected COLLECT still writes its row, carrying the
    // rejection status; see xchain-indexer collect.js, which calls createRewardClaim
    // unconditionally). Filters on (source, txHash) so the test asserts the reason.
    async sendCollectInvalid(addressInfo, amount){
        let address = addressInfo["address"]
        let msg = "COLLECT|0"
        if(amount !== undefined && amount !== null)
            msg += "|" + amount

        console.log("Creating and sending (expected-invalid) COLLECT V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for the recorded reward_claims row in the database...")
        let row = await waitForAnyRewardClaim({ source: address, txHash: txHash })

        return { txHash, claim: row }
    },

    // STAKE v3: contract-targeted stake (any tick). The contract must have been
    // deployed with cooldown_blocks + slash_destination set (DEPLOY v1+).
    async sendStakeV3(addressInfo, amount, signingPubkey, contractIndex, tick){
        let address = addressInfo["address"]
        let msg = "STAKE|3|" + amount + "|" + signingPubkey + "|" + contractIndex + "|" + tick

        console.log("Creating and sending STAKE V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for contract stake in the database...")
        let stakeRow = requireRow(await indexerDatabase.waitForContractStake({
            source:         address,
            signingPubkey:  signingPubkey,
            contractIndex:  contractIndex,
            tick:           tick,
            txHash:         txHash,
            status:         "valid"
        }), "sendStakeV3: the contract STAKE of " + amount + " " + tick + " into contract "
            + contractIndex + " (tx " + txHash + ") at status=valid")

        stakeTeardown.registerStake({ addressInfo, signingPubkey, amount, contractIndex, tick })

        return { txHash, stake: stakeRow }
    },

    // STAKE v3 expected to be REJECTED. The valid-only waitForContractStake can never
    // observe an intentionally-invalid stake, so broadcast and poll the row
    // status-agnostically (invalid contract stakes still write a contract_stakes row
    // carrying the rejection status (see xchain-indexer stake.js _parseContractStake,
    // which calls createContractStake unconditionally). Filters on the unique
    // (source, pubkey, target, tick) tuple, not txHash, so it stays robust to encoding.
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

    // UNSTAKE v1: begin cooldown for a contract-targeted stake
    // Optional trailing `amount` (partial unstake): omitted = full sweep.
    async sendUnstakeV1(addressInfo, signingPubkey, contractIndex, tick, amount){
        let address = addressInfo["address"]
        let msg = "UNSTAKE|1|" + signingPubkey + "|" + contractIndex + "|" + tick
        if(amount !== undefined && amount !== null)
            msg += "|" + amount

        console.log("Creating and sending UNSTAKE V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for contract unstake in the database...")
        let unstakeRow = requireRow(await indexerDatabase.waitForContractUnstake({
            source:        address,
            signingPubkey: signingPubkey,
            contractIndex: contractIndex,
            tick:          tick,
            txHash:        txHash,
            status:        "valid"
        }), "sendUnstakeV1: the contract UNSTAKE of " + tick + " from contract "
            + contractIndex + " (tx " + txHash + ") at status=valid")

        stakeTeardown.noteUnstake({ signingPubkey, contractIndex, tick, amount })

        return { txHash, unstake: unstakeRow }
    },

    // DELEGATE v1: rotate signing key for a contract-targeted stake
    async sendDelegateV1(addressInfo, newSigningPubkey, contractIndex, tick){
        let address = addressInfo["address"]
        let msg = "DELEGATE|1|" + newSigningPubkey + "|" + contractIndex + "|" + tick

        console.log("Creating and sending DELEGATE V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for contract delegation in the database...")
        let delegationRow = requireRow(await indexerDatabase.waitForContractDelegation({
            source:        address,
            contractIndex: contractIndex,
            tick:          tick,
            txHash:        txHash,
            status:        "valid"
        }), "sendDelegateV1: the contract DELEGATE on contract " + contractIndex
            + "/" + tick + " (tx " + txHash + ") at status=valid")

        return { txHash, delegation: delegationRow }
    }
}
