const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendStakeV0(addressInfo, tier, chains, signingPubkey){
        let address = addressInfo["address"]
        let msg = "STAKE|0|" + tier + "|" + (chains || "") + "|" + signingPubkey

        console.log("Creating and sending STAKE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for stake in the database...")
        let stakeRow = await indexerDatabase.waitForStake({
            source: address,
            tier: tier,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, stake: stakeRow }
    },

    async sendUnstakeV0(addressInfo, tier){
        let address = addressInfo["address"]
        let msg = "UNSTAKE|0|" + tier

        console.log("Creating and sending UNSTAKE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for unstake in the database...")
        let unstakeRow = await indexerDatabase.waitForUnstake({
            source: address,
            tier: tier,
            txHash: txHash,
            status: "valid"
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
