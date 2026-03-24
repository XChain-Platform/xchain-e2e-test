const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendDestroyV0(addressInfo, tick, amount, memo){
        let destroyMessage = "DESTROY|0|"+tick+"|"+amount+"|"+memo

        console.log("Creating and sending DESTROY V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, destroyMessage)

        console.log("Waiting for DESTROY in the database...")
        let destroyRow = await indexerDatabase.waitForDestroy({
            txHash: txHash,
            source: addressInfo["address"],
            tick: tick,
            amount: amount,
            status: "valid"
        })

        let debitRow = await indexerDatabase.waitForDebit({
            address: addressInfo["address"],
            tick: tick,
            txHash: txHash,
            amount: amount
        })

        return { txHash, destroy: destroyRow, debit: debitRow }
    },

    async sendDestroyV1(addressInfo, destroys, memo){
        // destroys = [{tick, amount}, {tick, amount}, ...]
        let destroyMessage = "DESTROY|1"
        for (let d of destroys) {
            destroyMessage += "|"+d.tick+"|"+d.amount
        }
        if (memo) destroyMessage += "|"+memo

        console.log("Creating and sending DESTROY V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, destroyMessage)

        console.log("Waiting for DESTROY in the database...")
        let firstDestroyRow = await indexerDatabase.waitForDestroy({
            txHash: txHash,
            source: addressInfo["address"],
            tick: destroys[0].tick,
            amount: destroys[0].amount,
            status: "valid"
        })

        return { txHash, destroy: firstDestroyRow }
    },

    async sendDestroyV2(addressInfo, destroys){
        // destroys = [{tick, amount, memo}, {tick, amount, memo}, ...]
        let destroyMessage = "DESTROY|2"
        for (let d of destroys) {
            destroyMessage += "|"+d.tick+"|"+d.amount+"|"+(d.memo || "")
        }

        console.log("Creating and sending DESTROY V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, destroyMessage)

        console.log("Waiting for DESTROY in the database...")
        let firstDestroyRow = await indexerDatabase.waitForDestroy({
            txHash: txHash,
            source: addressInfo["address"],
            tick: destroys[0].tick,
            amount: destroys[0].amount,
            status: "valid"
        })

        return { txHash, destroy: firstDestroyRow }
    }
}
