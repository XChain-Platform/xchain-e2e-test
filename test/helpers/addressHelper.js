const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendAddressV0(addressInfo, feePreference, requireMemo, memo){
        let addressMessage = "ADDRESS|0|"+feePreference+"|"+requireMemo+"|"+memo

        console.log("Creating and sending ADDRESS V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, addressMessage)

        console.log("Waiting for ADDRESS in the database...")
        let row = await indexerDatabase.waitForAddressOption({
            txHash: txHash,
            source: addressInfo["address"],
            feePreference: feePreference,
            requireMemo: requireMemo,
            status: "valid"
        })

        return { txHash, addressOption: row }
    }
}
