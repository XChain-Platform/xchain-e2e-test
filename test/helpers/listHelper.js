const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendListV0(addressInfo, type, items){
        let address = addressInfo["address"]
        let listMessage = "LIST|0|"+type+"|"+items.join("|")

        console.log("Creating and sending LIST V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, listMessage)

        let listRow = await indexerDatabase.waitForList({
            source: address, txHash: txHash, type: type,
            status: "valid", items
        })

        return { txHash, list: listRow }
    },

    async sendListV1(addressInfo, edit, listActionIndex, items, finalTypeToCheck, finalItemsToCheck){
        let address = addressInfo["address"]
        let listMessage = "LIST|1|"+edit+"|"+listActionIndex+"|"+items.join("|")

        console.log("Creating and sending LIST V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, listMessage)

        let listRow = await indexerDatabase.waitForList({
            source: address, txHash: txHash, type: finalTypeToCheck,
            status: "valid", items: finalItemsToCheck
        })

        return { txHash, list: listRow }
    }
}
