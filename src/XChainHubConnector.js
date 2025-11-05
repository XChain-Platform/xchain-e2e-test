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
 * XChain End-to-End Test Suite - Hub Connector
 * 
 * This file handles connecting to XChain hub instances
 * 
 ********************************************************************/

// Load required libraries
const axios = require('axios');

class XChainHubConnector {
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
    
    async getAllConfig(){
        const data = {
            jsonrpc: '2.0',
            method: 'getallconfigs',
            params: [],
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

module.exports = XChainHubConnector