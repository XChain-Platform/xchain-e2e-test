const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendDispenserV0(addressInfo, giveCoin, giveTick, giveAmount,
      giveEscrow, getCoin, getTick, getAmount, getAddress, fiatCode,
      fiatAmount, oracleAddress, expiration, allowList, blockList, memo
    ){
        let address = addressInfo["address"]

        if (giveCoin == null) giveCoin = ""
        if (giveTick == null) giveTick = ""
        if (getCoin == null) getCoin = ""
        if (getTick == null) getTick = ""
        if (fiatCode == null) fiatCode = ""
        if (fiatAmount == null) fiatAmount = ""
        if (oracleAddress == null) oracleAddress = ""
        if (expiration == null) expiration = ""
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""

        let dispenserMessage = "DISPENSER|0"
            +"|"+giveCoin+"|"+giveTick+"|"+giveAmount+"|"+giveEscrow
            +"|"+getCoin+"|"+getTick+"|"+getAmount+"|"+getAddress
            +"|"+fiatCode+"|"+fiatAmount+"|"+oracleAddress
            +"|"+expiration+"|"+allowList+"|"+blockList+"|"+memo

        console.log("Creating and sending DISPENSER V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, dispenserMessage)

        let dispenserRow = await indexerDatabase.waitForDispenser({
            source: address, txHash: txHash,
            giveCoin: giveCoin, giveTick: giveTick,
            giveAmount: giveAmount, giveEscrow: giveEscrow,
            getCoin: getCoin, getTick: getTick,
            getAmount: getAmount, getAddress: getAddress,
            fiatCode: fiatCode, fiatAmount: fiatAmount,
            expiration: expiration, allowList: allowList,
            blockList: blockList, memo: memo,
            status: "valid"
        })

        return { txHash, dispenser: dispenserRow }
    },

    async sendDispenserCancelV1(addressInfo, dispenserActionIndex, memo){
        let msg = "DISPENSER|1|"+dispenserActionIndex+"|"+(memo || "")

        console.log("Creating and sending DISPENSER CANCEL V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for DISPENSER cancel to be indexed...")
        await new Promise(r => setTimeout(r, 5000))

        return { txHash }
    },

    async sendDispenserEditV2(addressInfo, dispenserActionIndex, giveEscrow, expiration, allowList, blockList, memo){
        if (giveEscrow == null) giveEscrow = ""
        if (expiration == null) expiration = ""
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""

        let msg = "DISPENSER|2|"+dispenserActionIndex
            +"|"+giveEscrow+"|"+expiration+"|"+allowList+"|"+blockList+"|"+(memo || "")

        console.log("Creating and sending DISPENSER EDIT V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for DISPENSER edit to be indexed...")
        await new Promise(r => setTimeout(r, 5000))

        return { txHash }
    }
}
