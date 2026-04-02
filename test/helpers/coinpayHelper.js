const transactionHelper = require('../transactionHelper')

module.exports = {
    // Send a COINPAY v0 transaction with a native coin payment output
    // @param {addressInfo}           object  Sender wallet info (address, privateKey, etc.)
    // @param {orderMatchActionIndex} integer The ORDER_MATCH action_index being paid
    // @param {payeeAddress}          string  Seller's address to receive native coin
    // @param {coinAmountSatoshis}    integer Native coin amount in satoshis
    async sendCoinpayV0(addressInfo, orderMatchActionIndex, payeeAddress, coinAmountSatoshis){
        let coinpayMessage = "COINPAY|0|"+orderMatchActionIndex

        // The COINPAY transaction must include a native coin payment output
        let customOutputs = [{ address: payeeAddress, value: coinAmountSatoshis }]

        console.log("Creating and sending COINPAY V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(
            addressInfo, coinpayMessage, null, customOutputs
        )

        console.log("Waiting for COINPAY in the database...")
        let coinpay = await indexerDatabase.waitForCoinpay({
            obligationActionIndex: orderMatchActionIndex,
            status: 'valid'
        })

        return { txHash, coinpay }
    }
}
