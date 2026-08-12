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

        var response = null
        try {
            response = await axios.post(this.url, data)
        } catch (err) {
            console.log(err)
            return false
        }

        if (response.data && response.data.result) {
            return true;
        } else {
            return false
        }
    }

    // Rebuild the key-path cancel of an unrevealed envelope commit (spec §3.5)
    // from the persisted recovery record alone: {commit outpoint, value, internal
    // key, tapleaf hash} plus where the funds should go. The encoder holds no state
    // between calls, so this genuinely reconstructs the BIP341 tweak from the record
    // rather than from anything left over from the build; losing that record is what
    // strands the commit's value in an address the wallet cannot re-derive.
    async createEnvelopeCancelTx({ commitTxid, commitVout, commitValue, internalPubkey, tapleafHash, destination, feePerKb = null }){
        const dataToSend = {
            jsonrpc: '2.0',
            method: 'create_envelope_cancel_tx',
            params: { commitTxid, commitVout, commitValue, internalPubkey, tapleafHash, destination, feePerKb },
            id: 1
        }

        let response = null
        try {
            response = await axios.post(this.url, dataToSend)
        } catch (err){
            throw new Error('Error trying to create an envelope cancel tx: ' + (err && err.message))
        }

        if (response.data.result) return response.data.result
        const rpcErr = response.data && response.data.error
        throw new Error('Error trying to create an envelope cancel tx: ' +
            (rpcErr ? (rpcErr.message || JSON.stringify(rpcErr)) : 'no result and no error returned'))
    }

    // `compress` is TRI-STATE and deliberately last: null/undefined leaves the
    // encoder's own default in force (XCHAIN_COMPRESSION_DEFAULT, on unless the
    // deploy sets it off), while true/false are the caller's explicit choice.
    // Every existing caller omits it and keeps the shipped behaviour.
    async createTx(utxosList, pubkey, customOutputs, data, rawData, exactFee, rbf, outputType, changeAddress, p2shHash, p2shHex, compressedPubKey, unconfirmed, compress = null){
        const dataToSend = {
            jsonrpc: '2.0',
            method: 'create_tx',
            params: {
                compress:compress,
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
            response = await axios.post(this.url, dataToSend)
        } catch (err){
            console.log(err)
            throw new Error('Error trying to create a tx with the encoder module: ' + (err && err.message));
        }

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