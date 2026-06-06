/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain End-to-End Test Suite - Blockchain Connector Class
 *
 * This file handles pulling blockchain data from a coin daemon
 *
 ********************************************************************/

// Load required libraries
const axios = require('axios')

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

        // Options configuration for axios (axios throws automatically on non-2xx)
        const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
        const options = {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`
            }
        };

        try {
            // Make the request to the node
            const response = await axios.post(this.url, data, options);

            const responseData = response.data;

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

            // Options configuration for axios
            const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
            const options = {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`
                }
            };

            // Make the request to the node (axios throws automatically on non-2xx)
            const response = await axios.post(this.url, data, options);

            const responseData = response.data;

            // Verify if there is a result and return the hex
            if (responseData.result && responseData.result.hex) {
                return responseData.result.hex;
            } else {
                throw new Error('Error getting transaction hex');
            }
        } catch (error) {
            console.error('Error:', error);
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

            // Options configuration for axios
            const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
            const options = {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`
                }
            };

            // Make the request to the node
            const response = await axios.post(this.url, data, options);

            const responseData = response.data;

            // Verify if there is a result and return the hex
            if (responseData.result) {
                return responseData.result
            } else {
                const nodeError = responseData.error ? JSON.stringify(responseData.error) : 'unknown error';
                throw new Error('Error sending transaction to the node: ' + nodeError);
            }
        } catch (error) {
            console.error('Error:', error);
            // Bitcoin/Litecoin/Dogecoin Core returns the JSON-RPC error body even
            // on HTTP 500 (the wire-format error). Axios rejects on non-2xx, so
            // surface the body it captured (error.response.data) — otherwise
            // non-standard-script / dust / sighash rejections would be masked
            // behind a generic axios message.
            if (error.response) {
                const body = typeof error.response.data === 'string'
                    ? error.response.data
                    : JSON.stringify(error.response.data);
                throw new Error(`Error trying to send a transaction to the node — HTTP ${error.response.status} ${error.response.statusText}: ${body}`);
            }
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

            // Options configuration for axios
            const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
            const options = {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`
                }
            };

            // Make the request to the node (axios throws automatically on non-2xx)
            const response = await axios.post(this.url, data, options);

            const responseData = response.data;

            // Verify if there is a result and return the hex
            if (responseData.result && responseData.result.feerate) {
                return responseData.result.feerate;
            } else {
                return 0.00001000
            }
        } catch (error) {
            console.error('Error:', error);
            throw error;
        }
    }

    // --- Generic JSON-RPC + regtest reorg primitives ---------------------------------
    // The class's other methods each duplicate the axios boilerplate; this is a thin
    // generic caller used by the chain/reorg helpers below (added for on-chain reorg
    // e2e — invalidateBlock orphans a sub-chain so the indexer's reorg rollback runs).
    async _rpc(method, params = []){
        const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
        const response = await axios.post(this.url, { jsonrpc: '2.0', id: 1, method, params }, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` }
        });
        const data = response.data;
        if (data.error) throw new Error(`${method} RPC error: ` + JSON.stringify(data.error));
        return data.result;
    }
    async getBlockCount(){ return await this._rpc('getblockcount'); }
    async getBestBlockHash(){ return await this._rpc('getbestblockhash'); }
    async getBlockHash(height){ return await this._rpc('getblockhash', [Number(height)]); }
    async invalidateBlock(hash){ return await this._rpc('invalidateblock', [hash]); }
    async reconsiderBlock(hash){ return await this._rpc('reconsiderblock', [hash]); }
    async getRawMempool(){ return await this._rpc('getrawmempool'); }
    // Mine a block containing EXACTLY `txs` (default: none) — ignores the mempool. This is
    // what lets a reorg DROP an orphaned tx: after invalidateBlock, mine empty blocks to build
    // a longer competing chain that excludes the mempool tx. (Bitcoin Core 0.19+ `generateblock`.)
    async generateBlock(address, txs = []){ return await this._rpc('generateblock', [address, txs]); }
}

module.exports = BlockchainConnector
