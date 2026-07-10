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
 ********************************************************************/

const axios = require('axios');

class RegtestMinerConnector {
    constructor(url, port, apiKey = null) {
        this.url = "http://"+url+":"+port
        this.port = port
        this.apiKey = apiKey || null
        // Mirror the regtest-miner's opt-in MINER_API_KEY (x-api-key header, 401 on
        // mismatch): when a key is configured, attach it to every request so an
        // authenticated miner does not 401 the e2e harness. No key -> no header,
        // byte-identical request to before, so existing two-arg callers are unaffected.
        this.reqConfig = this.apiKey ? { headers: { 'x-api-key': this.apiKey } } : {}
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
            response = await axios.post(this.url, data, this.reqConfig)
        } catch (err) {
            return false
        }

        // Gate on result.ready, not just result truthiness. The miner runs
        // prepareWallet() detached on startup so the port may listen before the
        // wallet address is set. ping() is single-shot; callers that must tolerate
        // a cold start / post-reset use waitForReady() below to poll until
        // ready=true, closing the "Invalid address" race (see df6a8f7).
        if (response.data && response.data.result && response.data.result.ready) {
            return true;
        } else {
            return false
        }
    }

    // Poll ping() until the miner reports ready=true or the timeout elapses. The
    // miner runs prepareWallet() detached on startup, so on a cold start / post-reset
    // the port can listen (and ping resolve) before the wallet can fund addresses.
    // A single ping() is therefore a race that can return false once and abort
    // bootstrap; waitForReady withholds clearance by retrying, which is what the
    // df6a8f7 ready-gate intended. Returns true once ready, false if still not ready
    // at the deadline (the caller treats false as a hard failure).
    async waitForReady(timeoutMs = 30000, intervalMs = 1000){
        const deadline = Date.now() + timeoutMs;
        while (true) {
            if (await this.ping()) return true;
            if (Date.now() >= deadline) return false;
            await this.sleep(intervalMs);
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
        const response = await axios.post(this.url, data, this.reqConfig)

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
        const response = await axios.post(this.url, data, this.reqConfig)
        const result = response.data && response.data.result

        // The controller returns the bare string "ok" on success and an
        // {error: "..."} body on rejected input (uuid:24c35056). Both are
        // truthy, so a plain truthiness check would read a rejected input as
        // success; throw instead so callers stop believing the cadence
        // changed when it did not.
        if (result && typeof result === 'object' && result.error) {
            throw new Error(result.error)
        }

        // Verify if there is a result and return it
        if (result) {
            return result
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
        const response = await axios.post(this.url, data, this.reqConfig)

        // Verify if there is a result and return it
        if (response.data && response.data.result) {
            return response.data.result
        } else {
            return null
        }
    }

    // Pause the regtest miner's adaptive auto-mine loop. Call before a
    // height-deterministic generateBlocks section so a stray mempool tx
    // cannot cause the miner to fire an extra block concurrently. Always
    // pair with resumeMining() in a finally block.
    async pauseMining(){
        const data = {
            jsonrpc: '2.0',
            method: 'pause_mining',
            params: {},
            id: 1
        }

        const response = await axios.post(this.url, data, this.reqConfig)

        if (response.data && response.data.result) {
            return response.data.result
        } else {
            return null
        }
    }

    // Resume the adaptive auto-mine loop after a pauseMining() call.
    async resumeMining(){
        const data = {
            jsonrpc: '2.0',
            method: 'continue_mining',
            params: {},
            id: 1
        }

        const response = await axios.post(this.url, data, this.reqConfig)

        if (response.data && response.data.result) {
            return response.data.result
        } else {
            return null
        }
    }

    // Mine `count` empty blocks via the regtest miner's generatetoaddress.
    // Use this in tests that need to advance block height past indexer
    // time-locked states (e.g. STAKE's ACTIVATION_DELAY_BLOCKS) without
    // sending real transactions.
    async generateBlocks(count){
        const data = {
            jsonrpc: '2.0',
            method: 'generate_blocks',
            params: {count: count},
            id: 1
        }

        const response = await axios.post(this.url, data, this.reqConfig)

        if (response.data && response.data.result) {
            return response.data.result
        } else {
            return null
        }
    }
}

module.exports = RegtestMinerConnector