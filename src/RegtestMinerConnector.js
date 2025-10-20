const axios = require('axios');

class RegtestMinerConnector {
    constructor(url, port) {
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
            return false
        }

        // Verify if there is a result and return it
        if (response.data && response.data.result) {
            return true;
        } else {
            return false
        }
    }
    
    async sendFunds(address, amount){
        const data = {
            jsonrpc: '2.0',
            method: 'send_funds',
            params: {address:address, amount:amount},
            id: 1
        }
        
        // Make the request to the node
        const response = await axios.post(this.url, data)

        // Verify if there is a result and return it
        if (response.data && response.data.result) {
            return response.data.result
        } else {
            return null
        }
    }
    
    async setMiningTime(maxTime, txAddedTime){
        const data = {
            jsonrpc: '2.0',
            method: 'set_mining_time',
            params: {"max_time":maxTime, "tx_added_time":txAddedTime},
            id: 1
        }
        
        // Make the request to the node
        const response = await axios.post(this.url, data)

        // Verify if there is a result and return it
        if (response.data && response.data.result) {
            return response.data.result
        } else {
            return null
        }
    }
	
	async setDefaultMiningTime(){
        const data = {
            jsonrpc: '2.0',
            method: 'set_default_mining_time',
            params: {},
            id: 1
        }
        
        // Make the request to the node
        const response = await axios.post(this.url, data)

        // Verify if there is a result and return it
        if (response.data && response.data.result) {
            return response.data.result
        } else {
            return null
        }
    }
}

module.exports = RegtestMinerConnector