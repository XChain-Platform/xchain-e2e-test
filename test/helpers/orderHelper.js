const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendOrderV0(addressInfo, giveCoin, giveTick, giveAmount, getCoin, getTick, getAmount,
      getAddress, expiration, allowList, blockList, memo
    ){
        if (getAddress == null) getAddress = ""
        if (expiration == null) expiration = ""
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""

        let orderMessage = "ORDER|0|"+giveCoin+"|"+giveTick+"|"+giveAmount
            +"|"+getCoin+"|"+getTick+"|"+getAmount+"|"+getAddress
            +"|"+expiration+"|"+allowList+"|"+blockList+"|"+memo

        console.log("Creating and sending ORDER V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, orderMessage)

        console.log("Waiting for ORDER in the database...")
        let row = await indexerDatabase.waitForOrder({
            txHash: txHash,
            source: addressInfo["address"],
            giveCoin: giveCoin,
            giveTick: giveTick,
            giveAmount: giveAmount,
            getCoin: getCoin,
            getTick: getTick,
            getAmount: getAmount,
            status: "open"
        })

        return { txHash, order: row }
    },

    async sendOrderCancelV1(addressInfo, orderActionIndex, memo){
        let orderMessage = "ORDER|1|"+orderActionIndex+"|"+memo

        console.log("Creating and sending ORDER CANCEL V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, orderMessage)

        // After cancel, the original order status should change
        // Wait for the order to no longer be 'open'
        console.log("Waiting for ORDER cancel to be indexed...")
        // Give the indexer time to process
        await new Promise(r => setTimeout(r, 5000))

        return { txHash }
    }
}
