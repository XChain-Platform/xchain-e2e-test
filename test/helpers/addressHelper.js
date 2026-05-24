const transactionHelper = require('../transactionHelper')

module.exports = {
    // ADDRESS v0 wire format: ADDRESS|0|FEE_PREFERENCE|REQUIRE_MEMO|DISPENSER_PREFERENCE|MEMO
    // DISPENSER_PREFERENCE: 1=only owner can open dispenser (default), 2=anyone.
    async sendAddressV0(addressInfo, feePreference, requireMemo, memo, dispenserPreference){
        if (dispenserPreference == null) dispenserPreference = 1
        let addressMessage = "ADDRESS|0|"+feePreference+"|"+requireMemo+"|"+dispenserPreference+"|"+memo

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
