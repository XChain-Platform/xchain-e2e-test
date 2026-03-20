const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendBroadcastV0(addressInfo, message, value){
        let address = addressInfo["address"]
        let broadcastMessage = "BROADCAST|0|"+message+"|"+value

        console.log("Creating and sending BROADCAST V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, broadcastMessage)

        let broadcastRow = await indexerDatabase.waitForBroadcast({
            source: address, txHash: txHash, message: message,
            value: value, status: "valid"
        })

        return { txHash, broadcast: broadcastRow }
    },

    async sendBroadcastV1(addressInfo, message, value, fee, memo){
        let address = addressInfo["address"]
        let broadcastMessage = "BROADCAST|1|"+message+"|"+value+"|"+fee+"|"+memo

        console.log("Creating and sending BROADCAST V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, broadcastMessage)

        let broadcastRow = await indexerDatabase.waitForBroadcast({
            source: address, txHash: txHash, message: message,
            value: value, fee: fee, memo: memo, status: "valid"
        })

        return { txHash, broadcast: broadcastRow }
    },

    async sendBroadcastV2(addressInfo, message, fee, memo){
        let address = addressInfo["address"]
        let broadcastMessage = "BROADCAST|2|"+message+"|"+fee+"|"+memo

        console.log("Creating and sending BROADCAST V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, broadcastMessage)

        let broadcastRow = await indexerDatabase.waitForBroadcast({
            source: address, txHash: txHash, message: message,
            fee: fee, memo: memo, status: "valid"
        })

        return { txHash, broadcast: broadcastRow }
    },

    async sendBroadcastV3(addressInfo, broadcastActionIndex, value, memo){
        let address = addressInfo["address"]
        let broadcastMessage = "BROADCAST|3|"+broadcastActionIndex+"|"+value+"|"+memo

        console.log("Creating and sending BROADCAST V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, broadcastMessage)

        let broadcastRow = await indexerDatabase.waitForBroadcast({
            source: address, txHash: txHash, broadcastActionIndex: broadcastActionIndex,
            value: value, memo: memo, status: "valid"
        })

        return { txHash, broadcast: broadcastRow }
    }
}
