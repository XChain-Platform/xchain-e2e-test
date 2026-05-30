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
 * XChain End-to-End Test Suite - UTXO Tracker Connector
 * 
 * This file handles connecting to XChain UTXO tracker instances
 * 
 ********************************************************************/

// Load required libraries
const fetch = require('cross-fetch')

class UtxoTracker {
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
        
        // Options configuration for fetch
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        };
        
        // Make the request to the node
        const response = await fetch(this.url, options);
            
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
            
        const responseData = await response.json();
            
        // Verify if there is a result and return it
        if (responseData.result) {
            return true;
        } else {
            return false
        }
    }
    
    async getSyncStatus(){
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'get_sync_status',
                id: 1
            };
            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            };
            const response = await fetch(this.url, options);
            if (!response.ok) return null;
            const responseData = await response.json();
            return responseData.result || null;
        } catch (error) {
            return null;
        }
    }

    // Single-shot probe — returns the tracker's is_quiescent payload
    // (or null on RPC error). Caller waits via quiesce() below.
    async getQuiescentStatus(){
        try {
            const data = { jsonrpc: '2.0', method: 'is_quiescent', id: 1 };
            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            };
            const response = await fetch(this.url, options);
            if (!response.ok) return null;
            const responseData = await response.json();
            return responseData.result || null;
        } catch (error) {
            return null;
        }
    }

    // Test framework barrier — polls tracker.is_quiescent until ready or
    // timeout. Pre-test/afterEach hooks call this so the next test starts
    // from a fully-settled stack (no mid-batch state, no mempool backlog).
    //
    // When something is still in flight, optionally nudge it forward by
    // mining a block via the regtest miner — this confirms any straggling
    // mempool tx and pushes the tracker into committing the latest batch.
    async quiesce({ timeoutMs = 30000, pollMs = 250, regtestMiner = null } = {}){
        const deadline = Date.now() + timeoutMs
        let last = null
        while (Date.now() < deadline){
            const status = await this.getQuiescentStatus()
            last = status
            if (status && status.ready) return status
            // Not ready — if a regtestMiner was passed, mine a block to
            // unblock mempool/batch progression.
            if (regtestMiner && status && status.mempool_size > 0){
                try { await regtestMiner.generateBlocks(1) } catch (e) {}
            }
            await this.sleep(pollMs)
        }
        return last  // Return the last status seen (may have ready=false)
    }

    async waitForUtxos(address, timeMax = 60000){
        const endTime = Date.now() + timeMax
        
        while (Date.now() < endTime){
            try {
                let addressUtxos = await this.getUtxosFromAddress(address)
                
                if (addressUtxos["utxos"].length > 0){
                    return true
                }
                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }
        
        return false
    }
    
    async getUtxosFromAddress(address) {
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'get_utxos',
                params: { address: address },
                id: 1
            };

            // Options configuration for fetch
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            };

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
                throw new Error('Error getting utxos');
            }
        } catch (error) {
            console.error('Error fetching UTXOs:', error);
            throw error;
        }
    }
}

module.exports = UtxoTracker