const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendSweepV0(addressInfo, destination, balances, ownerships, escrows, memo){
        if (balances == null) balances = 1
        if (ownerships == null) ownerships = 1
        if (escrows == null) escrows = 0

        let sweepMessage = "SWEEP|0|"+destination+"|"+balances+"|"+ownerships+"|"+escrows+"|"+memo

        console.log("Creating and sending SWEEP V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sweepMessage)

        console.log("Waiting for SWEEP in the database...")
        let row = await indexerDatabase.waitForSweep({
            txHash: txHash,
            source: addressInfo["address"],
            destination: destination,
            status: "valid"
        })

        return { txHash, sweep: row }
    }
}
