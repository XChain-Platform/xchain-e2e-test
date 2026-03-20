const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendIssueV0(addressInfo, tick, maxSupply, maxMint, decimals, description, mintSupply,
        transfer='', transferSupply='', lockMaxSupply='', lockMaxMint='', lockDescription='', lockRug='',
        lockSleep='', lockCallback='', callbackBlock='', callbackTick='', callbackAmount='',
        allowList='', blockList='', mintAddressMax='', mintStartBlock='', mintStopBlock='', lockMint='',
        lockMintSupply=''
    ){
        let address = addressInfo["address"]

        let issueMessage = "ISSUE|0|"+tick+"|"+maxSupply
            +"|"+maxMint+"|"+decimals+"|"+description+"|"+mintSupply
            +"|"+transfer+"|"+transferSupply+"|"+lockMaxSupply+"|"+lockMaxMint
            +"|"+lockDescription+"|"+lockRug+"|"+lockSleep+"|"+lockCallback
            +"|"+callbackBlock+"|"+callbackTick+"|"+callbackAmount+"|"+allowList
            +"|"+blockList+"|"+mintAddressMax+"|"+mintStartBlock+"|"+mintStopBlock
            +"|"+lockMint+"|"+lockMintSupply

        console.log("Creating and sending ISSUE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)

        console.log("Waiting for ISSUE in the database...")
        let issueRow = await indexerDatabase.waitForIssue({
            source: address,
            tick: tick,
            txHash: txHash,
            description: description,
            maxSupply: maxSupply,
            maxMint: maxMint,
            decimals: decimals,
            mintSupply: mintSupply,
            status: "valid"
        })

        let creditRow = await indexerDatabase.waitForCredit({
            address: address,
            tick: tick,
            txHash: txHash,
            amount: mintSupply
        })

        return { txHash, issue: issueRow, credit: creditRow }
    },

    async sendIssueV1(addressInfo, tick, description){
        let address = addressInfo["address"]

        let issueMessage = "ISSUE|1|"+tick+"|"+description

        console.log("Creating and sending ISSUE V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, issueMessage)

        console.log("Waiting for ISSUE in the database...")
        let issueRow = await indexerDatabase.waitForIssue({
            source: address,
            tick: tick,
            txHash: txHash,
            description: description,
            status: "valid"
        })

        return { txHash, issue: issueRow }
    }
}
