const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendDeployV0(addressInfo, code, gasLimit, constructorParams){
        let address = addressInfo["address"]
        let codeHex = Buffer.from(code, 'utf8').toString('hex')
        let msg = "DEPLOY|0|" + codeHex + "|" + gasLimit
        if(constructorParams) msg += "|" + constructorParams

        console.log("Creating and sending DEPLOY V0 tx...")
        // DEPLOY carries the full contract bytecode (hex-encoded) which can exceed
        // OP_RETURN limits — force P2SH (the helper supports its 2-tx finalizer).
        // Auto-selected P2WSH encoding hits "Not finalized" because the helper's
        // PSBT signing path only handles legacy P2PKH inputs + the P2SH finalizer.
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg, null, [], "P2SH")

        console.log("Waiting for contract in the database...")
        let contractRow = await indexerDatabase.waitForContract({
            source: address,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, contract: contractRow }
    },

    async sendExecuteV0(addressInfo, contractActionIndex, method, params){
        let address = addressInfo["address"]
        let msg = "EXECUTE|0|" + contractActionIndex + "|" + method
        if(params && params.length > 0) msg += "|" + params.join("|")

        console.log("Creating and sending EXECUTE V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for execution in the database...")
        let executionRow = await indexerDatabase.waitForExecution({
            contractIndex: contractActionIndex,
            caller: address,
            methodName: method,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, execution: executionRow }
    },

    async sendDepositV0(addressInfo, contractActionIndex, tick, quantity){
        let address = addressInfo["address"]
        let msg = "DEPOSIT|0|" + contractActionIndex + "|" + tick + "|" + quantity

        console.log("Creating and sending DEPOSIT V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for deposit in the database...")
        let depositRow = await indexerDatabase.waitForDeposit({
            source: address,
            contractIndex: contractActionIndex,
            tick: tick,
            amount: quantity,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, deposit: depositRow }
    },

    async sendWithdrawV0(addressInfo, contractActionIndex, tick, quantity){
        let address = addressInfo["address"]
        let msg = "WITHDRAW|0|" + contractActionIndex + "|" + tick + "|" + quantity

        console.log("Creating and sending WITHDRAW V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg)

        console.log("Waiting for withdrawal in the database...")
        let withdrawalRow = await indexerDatabase.waitForWithdrawal({
            source: address,
            contractIndex: contractActionIndex,
            tick: tick,
            amount: quantity,
            txHash: txHash,
            status: "valid"
        })

        return { txHash, withdrawal: withdrawalRow }
    }
}
