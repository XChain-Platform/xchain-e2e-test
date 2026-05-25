const transactionHelper = require('../transactionHelper')

module.exports = {
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
        let msg = "REVOKE_DELEGATION|0|" + signingPubkey

        console.log("Creating and sending REVOKE_DELEGATION V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for revocation in the database...")
        let revocationRow = await indexerDatabase.waitForDelegation({
            source: address,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, revocation: revocationRow }
    },

    async sendClaimRewardsV0(addressInfo){
        let address = addressInfo["address"]
        let msg = "CLAIM_REWARDS|0"

        console.log("Creating and sending CLAIM_REWARDS V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for reward claim in the database...")
        let claimRow = await indexerDatabase.waitForRewardClaim({
            source: address,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, claim: claimRow }
    }
}
