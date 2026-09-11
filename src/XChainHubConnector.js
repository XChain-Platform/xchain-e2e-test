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
 * XChain End-to-End Test Suite - Hub Connector
 *
 * This file handles connecting to XChain hub instances with
 * multi-endpoint fallback for high availability.
 *
 ********************************************************************/

// Load required libraries
const axios = require('axios');
const coins = require('./coins');

// Local { coin -> consensusHash } per network, computed on first use. The vendored
// bundle cannot change under a running process, so re-hashing it on every config
// fetch would be pure waste.
const LOCAL_CONSENSUS_HASHES = {};
function localConsensusHashes(network){
    if(!LOCAL_CONSENSUS_HASHES[network]) LOCAL_CONSENSUS_HASHES[network] = coins.consensusHashes(network);
    return LOCAL_CONSENSUS_HASHES[network];
}

class XChainHubConnector {

    // Accept an array of endpoint URLs or a single host+port for backward compatibility
    constructor(endpoints, port) {
        if(Array.isArray(endpoints)){
            this.urls = endpoints;
        } else {
            this.urls = ["http://" + endpoints + ":" + port];
        }
        // Per-endpoint failure detail from the most recent _call(). Populated with
        // "url → code|message" strings for each unreachable endpoint so callers
        // can report exactly what was tried and why, instead of a bare null.
        this.lastFailures = [];
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
        this.lastFailures = [];
        // Attach x-api-key when HUB_API_KEY is configured (keyed venues): the
        // hub gates writes AND getallconfigs behind it; other reads ignore it.
        let headers = {};
        if(process.env.HUB_API_KEY) headers['x-api-key'] = process.env.HUB_API_KEY;
        for(let url of this.urls){
            try {
                let response = await axios.post(url, data, { timeout, headers });
                if(response.data && response.data.result !== undefined)
                    return response.data.result;
            } catch(err){
                if(err.response && err.response.data && err.response.data.result !== undefined){
                    degraded = err.response.data.result;
                } else {
                    this.lastFailures.push(url + ' → ' + (err.code || err.message));
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
        // connection failure; log the degraded state so it stays visible.
        if(result && typeof result === 'object' && result.status === 'degraded'){
            console.warn('Hub reachable but reporting degraded state: ', result);
        }
        return result !== null;
    }

    async getAllConfig(){
        let result = await this._call({ jsonrpc: '2.0', method: 'getallconfigs', params: [], id: 1 });
        // A degraded hub returns {status:"degraded"} and a failed config fetch
        // returns {error:...}; neither is a config tree. Don't let those
        // masquerade as config. Return null so the caller takes its
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
        this._checkHubConsensusHash(result && typeof result === 'object' ? result.coin_consensus_hashes : null);
        if(result && typeof result === 'object' && result.configs && typeof result.configs === 'object' && ('seq' in result)){
            return result.configs;
        }
        return result;
    }

    // Transport-integrity check: compare the consensus-config hashes the hub serves
    // on getallconfigs against our OWN vendored ones. Hub-served consensus values are
    // never applied (the suite derives them from the vendored src/coins bundle), so
    // this only logs; what it buys is that a hub built from a divergent bundle names
    // itself at the first config fetch instead of surfacing as an unexplained
    // action-level failure deep in a run. Widened to every coin and network because
    // the suite drives whatever chain set the venue's hub hands it.
    _checkHubConsensusHash(hubHashes){
        if(!hubHashes || typeof hubHashes !== 'object') return;   // older hub: field absent
        let mismatches = [];
        for(const network of coins.NETWORKS){
            let served = hubHashes[network];
            if(!served || typeof served !== 'object') continue;
            let local = localConsensusHashes(network);
            for(const tick of Object.keys(local)){
                // A coin the hub does not serve is version skew, not drift; only a
                // hash the hub DOES serve and that differs counts as a mismatch.
                if(served[tick] && served[tick] !== local[tick])
                    mismatches.push(tick + '/' + network + ': hub ' + served[tick] + ' vs vendored ' + local[tick]);
            }
        }
        // Callers re-fetch config freely, so log only when the mismatch SET changes:
        // a standing divergence must not flood a test run's output, and a drift that
        // widens or clears must still report.
        let key = mismatches.join('|');
        if(key === (this._lastConsensusMismatchKey || '')) return;
        this._lastConsensusMismatchKey = key;
        if(mismatches.length)
            console.error('CONSENSUS HASH MISMATCH: the hub serves consensus config differing from this suite\'s vendored coin files (' +
                mismatches.join('; ') + '). Hub consensus values are never applied (they are pinned locally); upgrade the lagging side.');
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
