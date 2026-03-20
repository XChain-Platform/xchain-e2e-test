const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendSleepV0(addressInfo, resumeBlock, memo){
        let sleepMessage = "SLEEP|0|"+resumeBlock+"|"+memo

        console.log("Creating and sending SLEEP V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sleepMessage)

        console.log("Waiting for SLEEP in the database...")
        let row = await indexerDatabase.waitForSleep({
            txHash: txHash,
            source: addressInfo["address"],
            resumeBlock: resumeBlock,
            status: "valid"
        })

        return { txHash, sleep: row }
    },

    async sendSleepV1(addressInfo, resumeBlock, tick, memo){
        let sleepMessage = "SLEEP|1|"+resumeBlock+"|"+tick+"|"+memo

        console.log("Creating and sending SLEEP V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sleepMessage)

        console.log("Waiting for SLEEP in the database...")
        let row = await indexerDatabase.waitForSleep({
            txHash: txHash,
            source: addressInfo["address"],
            tick: tick,
            resumeBlock: resumeBlock,
            status: "valid"
        })

        return { txHash, sleep: row }
    }
}
