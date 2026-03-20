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
    }
}
