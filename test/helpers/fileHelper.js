const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendFileV0(addressInfo, name, type, title, memo, rawData){
        let fileMessage = "FILE|0|"+name+"|"+type+"|"+title+"|"+memo

        console.log("Creating and sending FILE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, fileMessage, rawData)

        console.log("Waiting for FILE in the database...")
        let row = await indexerDatabase.waitForFile({
            txHash: txHash,
            source: addressInfo["address"],
            name: name,
            title: title,
            status: "valid"
        })

        return { txHash, file: row }
    }
}
