const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendBatchV0(addressInfo, commands){
        let batchMessage = "BATCH|0|"+commands.join(";")

        console.log("Creating and sending BATCH V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, batchMessage)

        console.log("Waiting for BATCH in the database...")
        let row = await indexerDatabase.waitForBatch({
            txHash: txHash,
            source: addressInfo["address"],
            status: "valid"
        })

        return { txHash, batch: row }
    }
}
