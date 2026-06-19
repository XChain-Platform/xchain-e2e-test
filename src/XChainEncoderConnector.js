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
 * XChain End-to-End Test Suite - Encoder Connector
 * 
 * This file handles connecting to XChain encoder instances
 * 
 ********************************************************************/

// Load required libraries
const axios = require('axios');

class XChainEncoderConnector {
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
    
    async createTx(utxosList, pubkey, customOutputs, data, rawData, exactFee, rbf, outputType, changeAddress, p2shHash, p2shHex, compressedPubKey, unconfirmed){
        const dataToSend = {
            jsonrpc: '2.0',
            method: 'create_tx',
            params: {
                utxos:utxosList,
                pubkey:pubkey,
                customOutputs:customOutputs,
                data:data,
                rawData:rawData,
                fee:exactFee,
                rbf:rbf,
                encoding:outputType,
                change:changeAddress,
                p2shHash:p2shHash,
                p2shHex:p2shHex,
                compressedPubKey:compressedPubKey,
                unconfirmed:unconfirmed
            },
            id: 1
        }
        
        let response = null
        try{
            // Make the request to the node
            response = await axios.post(this.url, dataToSend)
        } catch (err){
            console.log(err)
            throw new Error('Error trying to create a tx with the encoder module: ' + (err && err.message));
        }

        // Verify if there is a result and return it
        if (response.data.result) {
            return response.data.result;
        } else {
            // Surface the JSON-RPC error so callers (e.g. the stale-UTXO
            // retry helper) can pattern-match on the underlying cause.
            // Common transient: "no utxos were provided and no utxos found".
            const rpcErr = response.data && response.data.error;
            const detail = rpcErr ? (rpcErr.message || JSON.stringify(rpcErr)) : 'no result and no error returned';
            throw new Error('Error trying to create a tx with the encoder module: ' + detail);
        }
    }
}

module.exports = XChainEncoderConnector