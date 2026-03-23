const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendSwapV0(addressInfo, giveCoin, giveTick, giveAmount, getCoin, getTick, getAmount,
      getAddress, expiration, allowList, blockList, memo
    ){
        if (getAddress == null) getAddress = ""
        if (expiration == null) expiration = ""
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""

        let swapMessage = "SWAP|0|"+giveCoin+"|"+giveTick+"|"+giveAmount
            +"|"+getCoin+"|"+getTick+"|"+getAmount+"|"+getAddress
            +"|"+expiration+"|"+allowList+"|"+blockList+"|"+memo

        console.log("Creating and sending SWAP V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, swapMessage)

        console.log("Waiting for SWAP in the database...")
        let row = await indexerDatabase.waitForSwap({
            txHash: txHash,
            source: addressInfo["address"],
            giveCoin: giveCoin,
            giveTick: giveTick,
            giveAmount: giveAmount,
            getCoin: getCoin,
            getTick: getTick,
            getAmount: getAmount,
            status: "valid"
        })

        return { txHash, swap: row }
    },

    async sendSwapCancelV1(addressInfo, swapActionIndex, memo){
        let swapMessage = "SWAP|1|"+swapActionIndex+"|"+memo

        console.log("Creating and sending SWAP CANCEL V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, swapMessage)

        console.log("Waiting for SWAP cancel to be indexed...")
        await new Promise(r => setTimeout(r, 5000))

        return { txHash }
    }
}
