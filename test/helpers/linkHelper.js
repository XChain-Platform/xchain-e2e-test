const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendLinkV0(addressInfo, coin1, coin1ActionIndex, coin2, coin2ActionIndex, memo){
        let linkMessage = "LINK|0|"+coin1+"|"+coin1ActionIndex+"|"+coin2+"|"+coin2ActionIndex+"|"+memo

        console.log("Creating and sending LINK V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, linkMessage)

        console.log("Waiting for LINK in the database...")
        let row = await indexerDatabase.waitForLink({
            txHash: txHash,
            source: addressInfo["address"],
            coin1: coin1,
            coin1ActionIndex: coin1ActionIndex,
            coin2: coin2,
            coin2ActionIndex: coin2ActionIndex,
            status: "valid"
        })

        return { txHash, link: row }
    }
}
