const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendDestroyV0(addressInfo, tick, amount, memo){
        let destroyMessage = "DESTROY|0|"+tick+"|"+amount+"|"+memo

        console.log("Creating and sending DESTROY V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, destroyMessage)

        console.log("Waiting for DESTROY in the database...")
        let destroyRow = await indexerDatabase.waitForDestroy({
            txHash: txHash,
            source: addressInfo["address"],
            tick: tick,
            amount: amount,
            status: "valid"
        })

        let debitRow = await indexerDatabase.waitForDebit({
            address: addressInfo["address"],
            tick: tick,
            txHash: txHash,
            amount: amount
        })

        return { txHash, destroy: destroyRow, debit: debitRow }
    }
}
