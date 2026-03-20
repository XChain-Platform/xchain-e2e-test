const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendMessageV3(addressInfo, destination, plaintextMessage){
        let messageStr = "MESSAGE|3|"+destination+"|"+plaintextMessage

        console.log("Creating and sending MESSAGE V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, messageStr)

        console.log("Waiting for MESSAGE in the database...")
        let row = await indexerDatabase.waitForMessage({
            txHash: txHash,
            source: addressInfo["address"],
            destination: destination,
            plaintextMessage: plaintextMessage,
            status: "valid"
        })

        return { txHash, message: row }
    }
}
