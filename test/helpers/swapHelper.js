const transactionHelper = require('../transactionHelper')

module.exports = {
    // SWAP v0 wire format:
    //   VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
    // giveOwnership / getOwnership are optional (default empty = 0). When set to 1,
    // the corresponding *Amount field is sent empty per the spec.
    async sendSwapV0(addressInfo, giveCoin, giveTick, giveAmount, getCoin, getTick, getAmount,
      getAddress, expiration, allowList, blockList, memo, giveOwnership, getOwnership
    ){
        if (getAddress == null) getAddress = ""
        if (expiration == null) expiration = ""
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""
        if (giveOwnership == null) giveOwnership = ""
        if (getOwnership == null) getOwnership = ""
        // Wire-format: ownership side carries empty *_AMOUNT. The DB stores NULL
        // for the empty side, so the waitFor predicate has to query with null.
        let giveAmountWire = (giveOwnership == 1) ? "" : giveAmount
        let getAmountWire  = (getOwnership  == 1) ? "" : getAmount
        let giveAmountQuery = (giveOwnership == 1) ? null : giveAmount
        let getAmountQuery  = (getOwnership  == 1) ? null : getAmount

        let swapMessage = "SWAP|0|"+giveCoin+"|"+giveTick+"|"+giveAmountWire+"|"+giveOwnership
            +"|"+getCoin+"|"+getTick+"|"+getAmountWire+"|"+getOwnership+"|"+getAddress
            +"|"+expiration+"|"+allowList+"|"+blockList+"|"+memo

        console.log("Creating and sending SWAP V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, swapMessage)

        console.log("Waiting for SWAP in the database...")
        let row = await indexerDatabase.waitForSwap({
            txHash: txHash,
            source: addressInfo["address"],
            giveCoin: giveCoin,
            giveTick: giveTick,
            giveAmount: giveAmountQuery,
            getCoin: getCoin,
            getTick: getTick,
            getAmount: getAmountQuery,
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
    },

    async sendSwapEditV2(addressInfo, swapActionIndex, expiration, allowList, blockList, memo){
        if (expiration == null) expiration = ""
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""

        let swapMessage = "SWAP|2|"+swapActionIndex
            +"|"+expiration+"|"+allowList+"|"+blockList+"|"+(memo || "")

        console.log("Creating and sending SWAP EDIT V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, swapMessage)

        console.log("Waiting for SWAP edit to be indexed...")
        await new Promise(r => setTimeout(r, 5000))

        return { txHash }
    }
}
