/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain End-to-End Test Suite - Blockchain Connector Class
 * 
 * This file handles pulling blockchain data from a coin daemon
 * 
 ********************************************************************/

// Load required libraries
const fetch = require('cross-fetch')

class BlockchainConnector {
    constructor(url, port, rpcUser, rpcPassword) {
        this.url = "http://"+url+":"+port
        this.rpcUser = rpcUser
        this.rpcPassword = rpcPassword
    }
    
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    
    async getNetworkInfo(){
        const data = {
            jsonrpc: '2.0',
            method: 'getnetworkinfo',
            id: 1
        };
        
        // Options configuration for fetch
        const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`
            },
            body: JSON.stringify(data)
        };

        try {
            // Make the request to the node
            const response = await fetch(this.url, options);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const responseData = await response.json();

            // Verify if there is a result and return it
            if (responseData.result) {
                return responseData.result;
            } else {
                throw new Error('Error getting network info');
            }
        } catch (error) {
            throw new Error(`Error in network request: ${error.message}`);
        }
    }

    async waitForTx(txid, timeMax = 10000){
        const endTime = Date.now() + timeMax
        
        while (Date.now() < endTime){
            try {
                let txHex = await this.getTransactionHex(txid)
                return true
            } catch(err) {
                await this.sleep(1000)
            }
        }
        
        return false
    }

    async getTransactionHex(txid, hexFormat = true) {
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'getrawtransaction',
                params: [txid, hexFormat],
                id: 1,
            };

            // Options configuration for fetch
            const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`
                },
                body: JSON.stringify(data)
            };

            // Make the request to the node
            const response = await fetch(this.url, options);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const responseData = await response.json();

            // Verify if there is a result and return the hex
            if (responseData.result && responseData.result.hex) {
                return responseData.result.hex;
            } else {
                throw new Error('Error getting transaction hex');
            }
        } catch (error) {
            console.error('Error:', error.message);
            throw error;
        }
    }
    
    async broadcastTx(txHex){
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'sendrawtransaction',
                params: [txHex],
                id: 1
            }
            
            // Options configuration for fetch
            const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`
                },
                body: JSON.stringify(data)
            };

            // Make the request to the node
            const response = await fetch(this.url, options);

            if (!response.ok) {
                // Bitcoin/Litecoin/Dogecoin Core returns the JSON-RPC error
                // body even on HTTP 500 (the wire-format error). Surface it
                // so non-standard-script / dust / sighash rejections aren't
                // masked behind a generic message.
                const bodyText = await response.text().catch(() => '<unreadable body>');
                throw new Error(`Error trying to send a transaction to the node — HTTP ${response.status} ${response.statusText}: ${bodyText}`);
            }

            const responseData = await response.json();

            // Verify if there is a result and return the hex
            if (responseData.result) {
                return responseData.result
            } else {
                const nodeError = responseData.error ? JSON.stringify(responseData.error) : 'unknown error';
                throw new Error('Error sending transaction to the node: ' + nodeError);
            }
        } catch (error) {
            console.error('Error:', error.message);
            throw error;
        }
    }
    
    async getFeePerKilobyte(blocksNumber) {
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'estimatesmartfee',
                params: [blocksNumber],
                id: 1,
            };

            // Options configuration for fetch
            const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`
                },
                body: JSON.stringify(data)
            };

            // Make the request to the node
            const response = await fetch(this.url, options);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const responseData = await response.json();

            // Verify if there is a result and return the hex
            if (responseData.result && responseData.result.feerate) {
                return responseData.result.feerate;
            } else {
                return 0.00001000
            }
        } catch (error) {
            console.error('Error:', error.message);
            throw error;
        }
    }
}

module.exports = BlockchainConnector