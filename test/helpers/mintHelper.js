const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendMintV0(addressInfo, tick, amount, destination, memo){
        // Default destination to the sender's own address (the common "mint to self"
        // case) and memo to empty — otherwise undefined arguments get string-
        // concatenated into the wire message as literal "undefined" and the
        // indexer rejects with `invalid: DESTINATION (format)`.
        if (destination == null) destination = addressInfo["address"]
        if (memo == null) memo = ""
        let mintMessage = "MINT|0|"+tick+"|"+amount+"|"+destination+"|"+memo

        console.log("Creating and sending MINT V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, mintMessage)

        console.log("Waiting for MINT in the database...")
        let mintRow = await indexerDatabase.waitForMint({
            txHash: txHash,
            tick: tick,
            destination: destination,
            amount: amount,
            memo: memo,
            status: "valid"
        })

        let creditRow = await indexerDatabase.waitForCredit({
            address: destination,
            tick: tick,
            txHash: txHash,
            amount: amount
        })

        return { txHash, mint: mintRow, credit: creditRow }
    }
}
