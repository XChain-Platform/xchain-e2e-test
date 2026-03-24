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
    },

    async sendMessageV0(addressInfo, destination, encryptionMethod, encryptionKey){
        let messageStr = "MESSAGE|0|"+destination+"|"+encryptionMethod+"|"+encryptionKey

        console.log("Creating and sending MESSAGE V0 (sender key) tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, messageStr)

        console.log("Waiting for MESSAGE in the database...")
        let row = await indexerDatabase.waitForMessage({
            txHash: txHash,
            source: addressInfo["address"],
            destination: destination,
            encryptionMethod: encryptionMethod,
            status: "valid"
        })

        return { txHash, message: row }
    },

    async sendMessageV1(addressInfo, destination, encryptionMethod, encryptionKey){
        let messageStr = "MESSAGE|1|"+destination+"|"+encryptionMethod+"|"+encryptionKey

        console.log("Creating and sending MESSAGE V1 (receiver key) tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, messageStr)

        console.log("Waiting for MESSAGE in the database...")
        let row = await indexerDatabase.waitForMessage({
            txHash: txHash,
            source: addressInfo["address"],
            destination: destination,
            encryptionMethod: encryptionMethod,
            status: "valid"
        })

        return { txHash, message: row }
    },

    async sendMessageV2(addressInfo, destination, encryptedMessage){
        let messageStr = "MESSAGE|2|"+destination+"|"+encryptedMessage

        console.log("Creating and sending MESSAGE V2 (encrypted) tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, messageStr)

        console.log("Waiting for MESSAGE in the database...")
        let row = await indexerDatabase.waitForMessage({
            txHash: txHash,
            source: addressInfo["address"],
            destination: destination,
            status: "valid"
        })

        return { txHash, message: row }
    }
}
