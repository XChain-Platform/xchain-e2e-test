const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendCallbackV0(addressInfo, tick, memo){
        let callbackMessage = "CALLBACK|0|"+tick+"|"+memo

        console.log("Creating and sending CALLBACK V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, callbackMessage)

        console.log("Waiting for CALLBACK in the database...")
        let row = await indexerDatabase.waitForCallback({
            txHash: txHash,
            source: addressInfo["address"],
            tick: tick,
            status: "valid"
        })

        return { txHash, callback: row }
    }
}
