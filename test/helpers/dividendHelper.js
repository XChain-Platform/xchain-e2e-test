const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendDividendV0(addressInfo, tick, dividendTick, amount, memo){
        let dividendMessage = "DIVIDEND|0|"+tick+"|"+dividendTick+"|"+amount+"|"+memo

        console.log("Creating and sending DIVIDEND V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, dividendMessage)

        console.log("Waiting for DIVIDEND in the database...")
        let row = await indexerDatabase.waitForDividend({
            txHash: txHash,
            source: addressInfo["address"],
            tick: tick,
            dividendTick: dividendTick,
            amount: amount,
            status: "valid"
        })

        return { txHash, dividend: row }
    }
}
