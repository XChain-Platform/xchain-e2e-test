const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendDispenserV0(addressInfo, giveCoin, giveTick, giveAmount,
      giveEscrow, getCoin, getTick, getAmount, getAddress, fiatCode,
      fiatAmount, expiration, allowList, blockList, memo
    ){
        let address = addressInfo["address"]

        if (giveCoin == null) giveCoin = ""
        if (giveTick == null) giveTick = ""
        if (getCoin == null) getCoin = ""
        if (getTick == null) getTick = ""
        if (fiatCode == null) fiatCode = ""
        if (fiatAmount == null) fiatAmount = ""
        if (expiration == null) expiration = ""
        if (allowList == null) allowList = ""
        if (blockList == null) blockList = ""

        let dispenserMessage = "DISPENSER|0"
            +"|"+giveCoin+"|"+giveTick+"|"+giveAmount+"|"+giveEscrow
            +"|"+getCoin+"|"+getTick+"|"+getAmount+"|"+getAddress
            +"|"+fiatCode+"|"+fiatAmount+"|"+expiration+"|"+allowList
            +"|"+blockList+"|"+memo

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
    }
}
