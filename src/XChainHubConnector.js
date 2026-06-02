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
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain End-to-End Test Suite - Hub Connector
 *
 * This file handles connecting to XChain hub instances with
 * multi-endpoint fallback for high availability.
 *
 ********************************************************************/

// Load required libraries
const axios = require('axios');

class XChainHubConnector {

    // Accept an array of endpoint URLs or a single host+port for backward compatibility
    constructor(endpoints, port) {
        if(Array.isArray(endpoints)){
            this.urls = endpoints;
        } else {
            this.urls = ["http://" + endpoints + ":" + port];
        }
    }

    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Internal: call a JSON-RPC method, trying each endpoint in order
    async _call(data, timeout = 5000){
        // A reachable-but-unhealthy hub responds with a non-2xx status (e.g. the
        // 503 "degraded" health body returned when its DB pool is down) that
        // still carries a valid JSON-RPC body. Axios throws on any non-2xx, so
        // without inspecting err.response that state is indistinguishable from an
        // unreachable endpoint. Capture such a body as a fallback, but keep
        // trying the remaining endpoints in case one is fully healthy.
        let degraded = null;
        for(let url of this.urls){
            try {
                let response = await axios.post(url, data, { timeout });
                if(response.data && response.data.result !== undefined)
                    return response.data.result;
            } catch(err){
                if(err.response && err.response.data && err.response.data.result !== undefined){
                    degraded = err.response.data.result;
                } else {
                    console.warn('Hub endpoint ' + url + ' failed: ', err);
                }
            }
        }
        // No endpoint returned a healthy result. Surface a reachable-but-degraded
        // response (if any) so callers can tell "up but DB down" from
        // "unreachable"; otherwise null, preserving the all-endpoints-failed signal.
        return degraded;
    }

    async ping(){
        let result = await this._call({ jsonrpc: '2.0', method: 'ping', id: 1 });
        // A reachable-but-degraded hub returns a non-null {status:"degraded"}
        // body. The hub is up, so report it as reachable rather than as a
        // connection failure — but log the degraded state so it stays visible.
        if(result && typeof result === 'object' && result.status === 'degraded'){
            console.warn('Hub reachable but reporting degraded state: ', result);
        }
        return result !== null;
    }

    async getAllConfig(){
        let result = await this._call({ jsonrpc: '2.0', method: 'getallconfigs', params: [], id: 1 });
        // A degraded hub returns {status:"degraded"} and a failed config fetch
        // returns {error:...}; neither is a config tree. Don't let those
        // masquerade as config — return null so the caller takes its
        // "couldn't get configs" path instead of indexing into a non-config object.
        if(result && typeof result === 'object' && (result.status === 'degraded' || result.error !== undefined)){
            console.warn('Hub did not return usable config: ', result);
            return null;
        }
        return this._applyConfigResult(result);
    }

    // Normalize the getallconfigs result to the flat coin→network→service tree.
    // Newer hubs wrap the payload as { configs, seq, watermark }; older hubs
    // return the bare tree directly. Callers index hubConfigs[coin][network]
    // [service][param], so unwrap the envelope when present.
    _applyConfigResult(result){
        if(result === null) return null;
        if(result && typeof result === 'object' && result.configs && typeof result.configs === 'object' && ('seq' in result)){
            return result.configs;
        }
        return result;
    }
}

// Parse hub endpoints from environment variables
XChainHubConnector.parseEndpoints = function(){
    if(process.env.HUB_VALIDATORS){
        return process.env.HUB_VALIDATORS.split(',')
            .map(e => e.trim())
            .filter(e => e)
            .map(e => e.startsWith('http') ? e : 'http://' + e);
    }
    // Backward compat: e2e-test uses HUB_URL, other services use HUB_API_HOST
    let host = process.env.HUB_URL || process.env.HUB_API_HOST || 'localhost';
    let port = process.env.HUB_PORT || '10000';
    return ['http://' + host + ':' + port];
};

module.exports = XChainHubConnector
