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

const axios = require('axios');
const { getLogger } = require('./lib/logger');
const logger = getLogger();

// What the SERVICE said, when it said anything at all.
// The indexer refuses a gated call with a non-2xx status whose body is still a
// JSON-RPC envelope (api.js: 401 + {error:{code:-32001,message:'Unauthorized...'}}).
// Axios rejects on any non-2xx, so a catch that never reads err.response cannot
// tell "the indexer refused this" from "nothing answered the socket".
// Returns null for a responseless failure (ECONNREFUSED, timeout, DNS), which is
// the only case the connectors' null/false sentinel is meant to cover.
function serviceRefusal(err){
    const res = err && err.response
    if(!res) return null
    const body = res.data && res.data.error
    if(body) return typeof body === 'object' ? (body.message || JSON.stringify(body)) : String(body)
    return 'HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : '')
}

class XChainIndexerConnector {
    constructor(url, port, apiKey) {
        this.url = "http://"+url+":"+port
        this.port = port
        this.apiKey = apiKey || null
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
            // A probe keeps its boolean sentinel: callers poll on false. Name the
            // refusal in the log so a gated port is not read as a dead one.
            const refusal = serviceRefusal(err)
            if(refusal) logger.warn('Indexer ' + this.url + ' refused ping: ' + refusal)
            else logger.info(err)
            return false
        }

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

        var response = null
        try {
            response = await axios.post(this.url, data)
        } catch (err) {
            // health() keeps its null sentinel deliberately: waitForIndexedBlock
            // polls it in a loop and must ride out a restarting indexer's non-2xx
            // window rather than abort the run. Name the refusal instead.
            const refusal = serviceRefusal(err)
            if(refusal) logger.warn('Indexer ' + this.url + ' refused health: ' + refusal)
            else logger.info(err)
            return null
        }

        if (response.data && response.data.result) {
            return response.data.result;
        } else {
            return null
        }
    }

    // Generic JSON-RPC call (object params). Returns the result on success, and
    // null only when the request never completed (transport failure). All three
    // error shapes THROW instead of reaching the caller as a value:
    //   - a non-2xx response carrying a JSON-RPC error body, which is how a gated
    //     method refuses an unauthorized call (401, code -32001). Axios rejects
    //     that response, so it arrives at the catch rather than the branches
    //     below; null there made an authentication refusal read as a dead socket.
    //   - a top-level response.data.error, which the router emits for an unknown
    //     method (version skew), a handler that threw outside its own try/catch,
    //     or a malformed body. Coercing it to null made a rejected RPC
    //     indistinguishable from a dead socket and discarded its message.
    //   - the { error: '...' } envelope the indexer returns INSIDE result for a
    //     method-level rejection. That envelope is truthy, so returning it let a
    //     caller that only tests the return for truthiness read a rejected query
    //     as its success payload.
    // The sibling RegtestMinerConnector._unwrap enforces the same contract for
    // the same reason; this is that contract applied to the indexer.
    async call(method, params){
        const data = {
            jsonrpc: '2.0',
            method: method,
            params: params,
            id: 1
        }
        var response = null
        try {
            const config = this.apiKey ? { headers: { 'x-api-key': this.apiKey } } : {}
            response = await axios.post(this.url, data, config)
        } catch (err) {
            // A gated method answers 401 with an RPC error BODY, and axios rejects
            // it. Coercing that to null broke this method's own contract two lines
            // up and disarmed rollcallHelper.assertGatedReadsReachable, whose catch
            // is what prints the INDEXER_API_KEY sentence; the generic null-result
            // assertion that fired instead never named authentication.
            const refusal = serviceRefusal(err)
            if(refusal) throw new Error('Indexer refused ' + method + ': ' + refusal)
            logger.info(err)
            return null
        }
        if (response.data && response.data.error) {
            const err = response.data.error
            throw new Error(typeof err === 'object' ? (err.message || JSON.stringify(err)) : String(err))
        }
        const result = response.data ? response.data.result : undefined
        if (result && typeof result === 'object' && result.error) {
            throw new Error(String(result.error))
        }
        // Test undefined/null rather than truthiness so a legitimately falsy but
        // DEFINED result (0, "", false) survives instead of collapsing to null.
        return (result === undefined || result === null) ? null : result
    }

    // Effective capability signer set at a block (resolves through the
    // indexer's consensus effective-set query: stake keys minus revocations
    // ∪ active delegated keys backed by the source's aggregate stake).
    // minStake is caller-supplied so tests don't depend on the venue's local
    // MIN_STAKE config. Returns { capability, block_index, count, validators },
    // or null on transport failure; a rejected query throws (see call()).
    async getCapabilityValidators(capability, blockIndex, minStake){
        return await this.call('getcapabilityvalidators', {
            capability:  capability,
            block_index: Number(blockIndex),
            min_stake:   minStake
        })
    }

    // Resolve the staking source address that owned/delegated a signing pubkey
    // as of a block (stakes first, then DELEGATE v0 delegations; block-scoped).
    // Returns { source } (source null when unknown), or null on transport
    // failure; a rejected query throws (see call()).
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