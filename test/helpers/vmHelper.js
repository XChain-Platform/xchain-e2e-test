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

    // DEPLOY v1 — stakeable contract. cooldownBlocks + slashDestination are required for the
    // contract to accept STAKE v3. slashDestination may be the string 'BURN' to route slashed
    // funds to the chain's burn address. Pass an empty string for constructorParams to skip.
    async sendDeployV1(addressInfo, code, gasLimit, constructorParams, cooldownBlocks, slashDestination){
        let address = addressInfo["address"]
        let codeHex = Buffer.from(code, 'utf8').toString('hex')
        let msg = "DEPLOY|1|" + codeHex + "|" + gasLimit + "|" + (constructorParams || '')
                  + "|" + cooldownBlocks + "|" + (slashDestination || '')

        console.log("Creating and sending DEPLOY V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, msg, null, [], "P2SH")

        console.log("Waiting for stakeable contract in the database...")
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
        // For P2SH-encoded txes the broadcast txid returned by sendrawtransaction
        // does not match the on-chain hash recorded in index_transactions, so
        // the strict txHash filter either catches the row on the first poll or
        // never matches at all — give it a short window, then fall back to a
        // no-txHash search using the remaining (contract, caller, method) tuple.
        let executionRow = await indexerDatabase.waitForExecution({
            contractIndex: contractActionIndex,
            caller: address,
            methodName: method,
            txHash: txHash,
            status: "valid"
        }, 5000)
        if(!executionRow){
            executionRow = await indexerDatabase.waitForExecution({
                contractIndex: contractActionIndex,
                caller: address,
                methodName: method,
                status: "valid"
            }, 55000)
        }

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
