/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain End-to-End Test Suite - Indexer Connector
 * 
 * This file handles connecting to XChain indexer instances
 * 
 ********************************************************************/

// Load required libraries
const axios = require('axios');

class XChainIndexerConnector {
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

    // Fetch the indexer's health report (sync state + DB circuit-breaker status).
    // Returns the result object on success, or null if the call fails.
    async health(){
        const data = {
            jsonrpc: '2.0',
            method: 'health',
            id: 1
        }

        // Make the request to the node
        var response = null
        try {
            response = await axios.post(this.url, data)
        } catch (err) {
            console.log(err)
            return null
        }

        // Verify if there is a result and return it
        if (response.data && response.data.result) {
            return response.data.result;
        } else {
            return null
        }
    }

    // Generic JSON-RPC call (object params). Returns the result object on
    // success, or null on transport failure. Method-level validation errors
    // come back as { error: '...' } INSIDE the result — callers must check.
    async call(method, params){
        const data = {
            jsonrpc: '2.0',
            method: method,
            params: params,
            id: 1
        }
        var response = null
        try {
            response = await axios.post(this.url, data)
        } catch (err) {
            console.log(err)
            return null
        }
        return (response.data && response.data.result) ? response.data.result : null
    }

    // Effective capability signer set at a block (resolves through the
    // indexer's consensus effective-set query: stake keys minus revocations
    // ∪ active delegated keys backed by the source's aggregate stake).
    // minStake is caller-supplied so tests don't depend on the venue's local
    // MIN_STAKE config. Returns { capability, block_index, count, validators }
    // or { error } or null.
    async getCapabilityValidators(capability, blockIndex, minStake){
        return await this.call('getcapabilityvalidators', {
            capability:  capability,
            block_index: Number(blockIndex),
            min_stake:   minStake
        })
    }

    // Resolve the staking source address that owned/delegated a signing pubkey
    // as of a block (stakes first, then DELEGATE v0 delegations — block-scoped).
    // Returns { source } (source null when unknown) or { error } or null.
    async getStakeSourceByPubkey(pubkey, blockIndex){
        return await this.call('getstakesourcebypubkey', {
            pubkey:      pubkey,
            block_index: Number(blockIndex)
        })
    }

    // Poll the health endpoint until the indexer has indexed at least
    // `minHeight`. Effective-set queries are block-scoped, so tests must not
    // read the set before the indexer reaches the activation/deactivation
    // block they are asserting about. Returns true once reached, false on timeout.
    async waitForIndexedBlock(minHeight, timeMax = 90000){
        const endTime = Date.now() + timeMax
        while(Date.now() < endTime){
            let health = await this.health()
            if(health && health.lastIndexedBlock !== null && Number(health.lastIndexedBlock) >= Number(minHeight))
                return true
            await this.sleep(1000)
        }
        return false
    }
}

module.exports = XChainIndexerConnector