const transactionHelper = require('../transactionHelper')

module.exports = {
    async sendSendV0(addressInfo, tick, amount, destination, memo){
        let address = addressInfo["address"]
        let sendMessage = "SEND|0|"+tick+"|"+amount+"|"+destination+"|"+memo

        console.log("Creating and sending SEND V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sendMessage)

        console.log("Waiting for SEND in the database...")
        let sendRow = await indexerDatabase.waitForSend({
            source: address,
            destination: destination,
            tick: tick,
            amount: amount,
            txHash: txHash,
            memo: memo,
            status: "valid"
        })

        let creditRow = await indexerDatabase.waitForCredit({
            address: destination,
            tick: tick,
            txHash: txHash,
            amount: amount
        })

        let debitRow = await indexerDatabase.waitForDebit({
            address: address,
            tick: tick,
            txHash: txHash,
            amount: amount
        })

        return { txHash, send: sendRow, credit: creditRow, debit: debitRow }
    },

    async sendSendV1(addressInfo, tick, amount1, destination1, amount2, destination2, memo){
        let address = addressInfo["address"]
        let sendMessage = "SEND|1|"+tick+"|"+amount1+"|"+destination1+"|"+amount2+"|"+destination2+"|"+memo

        console.log("Creating and sending SEND V1 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sendMessage)

        let send1Row = await indexerDatabase.waitForSend({
            source: address, destination: destination1, tick: tick,
            amount: amount1, txHash: txHash, memo: memo, status: "valid"
        })
        let send2Row = await indexerDatabase.waitForSend({
            source: address, destination: destination2, tick: tick,
            amount: amount2, txHash: txHash, memo: memo, status: "valid"
        })
        let credit1Row = await indexerDatabase.waitForCredit({
            address: destination1, tick: tick, txHash: txHash, amount: amount1
        })
        let credit2Row = await indexerDatabase.waitForCredit({
            address: destination2, tick: tick, txHash: txHash, amount: amount2
        })
        let debitRow = await indexerDatabase.waitForDebit({
            address: address, tick: tick, txHash: txHash, amount: amount1 + amount2
        })

        return { txHash, send1: send1Row, send2: send2Row, credit1: credit1Row, credit2: credit2Row, debit: debitRow }
    },

    async sendSendV2(addressInfo, tick1, amount1, destination1, tick2, amount2, destination2, memo){
        let address = addressInfo["address"]
        let sendMessage = "SEND|2|"+tick1+"|"+amount1+"|"+destination1+"|"+tick2+"|"+amount2+"|"+destination2+"|"+memo

        console.log("Creating and sending SEND V2 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sendMessage)

        let send1Row = await indexerDatabase.waitForSend({
            source: address, destination: destination1, tick: tick1,
            amount: amount1, txHash: txHash, memo: memo, status: "valid"
        })
        let send2Row = await indexerDatabase.waitForSend({
            source: address, destination: destination2, tick: tick2,
            amount: amount2, txHash: txHash, memo: memo, status: "valid"
        })
        let credit1Row = await indexerDatabase.waitForCredit({
            address: destination1, tick: tick1, txHash: txHash, amount: amount1
        })
        let credit2Row = await indexerDatabase.waitForCredit({
            address: destination2, tick: tick2, txHash: txHash, amount: amount2
        })
        let debit1Row = await indexerDatabase.waitForDebit({
            address: address, tick: tick1, txHash: txHash, amount: amount1
        })
        let debit2Row = await indexerDatabase.waitForDebit({
            address: address, tick: tick2, txHash: txHash, amount: amount2
        })

        return { txHash, send1: send1Row, send2: send2Row, credit1: credit1Row, credit2: credit2Row, debit1: debit1Row, debit2: debit2Row }
    },

    async sendSendV3(addressInfo, tick1, amount1, destination1, memo1, tick2, amount2, destination2, memo2){
        let address = addressInfo["address"]
        let sendMessage = "SEND|3|"+tick1+"|"+amount1+"|"+destination1+"|"+memo1+"|"+tick2+"|"+amount2+"|"+destination2+"|"+memo2

        console.log("Creating and sending SEND V3 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, sendMessage)

        let send1Row = await indexerDatabase.waitForSend({
            source: address, destination: destination1, tick: tick1,
            amount: amount1, txHash: txHash, memo: memo1, status: "valid"
        })
        let send2Row = await indexerDatabase.waitForSend({
            source: address, destination: destination2, tick: tick2,
            amount: amount2, txHash: txHash, memo: memo2, status: "valid"
        })
        let credit1Row = await indexerDatabase.waitForCredit({
            address: destination1, tick: tick1, txHash: txHash, amount: amount1
        })
        let credit2Row = await indexerDatabase.waitForCredit({
            address: destination2, tick: tick2, txHash: txHash, amount: amount2
        })
        let debit1Row = await indexerDatabase.waitForDebit({
            address: address, tick: tick1, txHash: txHash, amount: amount1
        })
        let debit2Row = await indexerDatabase.waitForDebit({
            address: address, tick: tick2, txHash: txHash, amount: amount2
        })

        return { txHash, send1: send1Row, send2: send2Row, credit1: credit1Row, credit2: credit2Row, debit1: debit1Row, debit2: debit2Row }
    }
}
