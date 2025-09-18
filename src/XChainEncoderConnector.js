const axios = require('axios');

class XChainEncoderConnector {
    constructor(url, port, rpcUser, rpcPassword) {
        this.url = "http://"+url+":"+port
        this.port = port
    }

    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async ping(){
        const data = {
            jsonrpc: '2.0',
            method: 'ping',
            id: 1
        }
        
        // Make the request to the node
        var response = null
        try {
            response = await axios.post(this.url, data)
        } catch (err) {
            console.log(err)
            return false
        }

        // Verify if there is a result and return it
        if (response.data && response.data.result) {
            return true;
        } else {
            return false
        }
    }
    
    async createTx(utxosList, pubkey, customOutputs, data, rawData, exactFee, rbf, outputType, changeAddress, p2shHash, p2shHex, compressedPubKey){
        const dataToSend = {
            jsonrpc: '2.0',
            method: 'create_tx',
            params: {
                utxosList:utxosList, 
                pubkey:pubkey,
                customOutputs:customOutputs, 
                data:data, 
                rawData:rawData,
                exactFee:exactFee, 
                rbf:rbf, 
                outputType:outputType,
                changeAddress:changeAddress,
                p2shHash:p2shHash, 
                p2shHex:p2shHex, 
                compressedPubKey:compressedPubKey
            },
            id: 1
        }
        
        let response = null
        try{
            // Make the request to the node
            response = await axios.post(this.url, dataToSend)
        } catch (err){
            console.log(err)
            throw new Error('Error trying to create a tx with the encoder module');
        }

        // Verify if there is a result and return it
        if (response.data.result) {
            return response.data.result;
        } else {
            throw new Error('Error trying to create a tx with the encoder module');
        }
    }
}

module.exports = XChainEncoderConnector