const mintHelper = require('./mintHelper')

const GAS_TICK = "XCHAIN"

module.exports = {
    async mintGas(addressInfo, amount){
        return await mintHelper.sendMintV0(
            addressInfo,
            GAS_TICK,
            amount,
            addressInfo["address"],
            ""
        )
    },

    // Test-fixture convenience: mint `amount` GAS to addressInfo. Each test run
    // generates fresh mnemonics so addresses start at zero balance — no need to
    // diff against current balance for idempotency in the e2e context.
    async ensureGasBalance(addressInfo, amount){
        return await this.mintGas(addressInfo, amount)
    }
}
