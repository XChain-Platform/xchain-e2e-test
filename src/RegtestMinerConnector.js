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

// Per-request cap for the readiness probe. axios defaults to no timeout, so a
// miner that accepts the socket and never answers left ping() pending forever
// and waitForReady ran past its advertised deadline without ever returning:
// a hung miner stalled CI instead of failing it. Only ping carries this cap;
// mining calls keep the unbounded config because generatetoaddress legitimately
// runs long.
const PING_TIMEOUT_MS = 5000;

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

    // The regtest-miner's JSON-RPC controller signals failure by returning a
    // truthy `{error: "..."}` object as `result`, never via an HTTP error (see
    // the setMiningTime comment below, uuid:24c35056). `{error}` is truthy, so
    // a plain truthiness check on `result` would hand the caller the error
    // object as if it were the success payload. Every result-returning method
    // routes through this helper so that contract is enforced uniformly.
    _unwrap(response) {
        // Top-level JSON-RPC error member: express-json-rpc-router emits
        // response.data.error (not result) when the method is unknown (version
        // skew), a handler throws outside its own try/catch, or the body was
        // malformed. In all of those response.data.result is undefined, so
        // without this guard the caller would read a rejected/failed RPC as a
        // null success. Throw before touching result so transport-level
        // failures never read as green.
        if (response.data && response.data.error) {
            const err = response.data.error
            throw new Error(typeof err === 'object' ? (err.message || JSON.stringify(err)) : err)
        }
        const result = response.data && response.data.result
        if (result && typeof result === 'object' && result.error) {
            throw new Error(result.error)
        }
        // A missing result is contract failure, not a success worth returning.
        // Every controller method answers with a DEFINED value on success ("ok",
        // a txid, {count, hashes}), so undefined/null means the miner replied
        // without the payload its contract promises: a drifted sidecar, a handler
        // that fell through, or an emptied body. Returning null let control ops
        // (setMiningTime, pauseMining, generateBlocks) read that as success,
        // because their callers only await them and discard the return.
        //
        // Falsy-but-DEFINED results still pass through untouched (0, "", false):
        // that is the separate contract uuid:d944b084 pinned, and this guard keeps
        // it by testing for undefined/null rather than for truthiness.
        if (result === undefined || result === null) {
            throw new Error('The regtest miner returned no result; the control operation is unconfirmed')
        }
        return result
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
            // Spread rather than mutate: this.reqConfig is shared by every other
            // method, which must stay unbounded. The catch below already turns a
            // timed-out request into a plain false, so a hung miner reads as
            // not-ready instead of never answering.
            response = await axios.post(this.url, data, { ...this.reqConfig, timeout: PING_TIMEOUT_MS })
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
            // Clamp the wait to what is left of the budget: a full intervalMs at
            // the tail overshot the advertised deadline by up to one interval on
            // every call, so the number the caller passed was never the bound.
            const remaining = deadline - Date.now();
            if (remaining <= 0) return false;
            await this.sleep(Math.min(intervalMs, remaining));
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

        // Verify if there is a result and return it (throws on an {error} envelope)
        return this._unwrap(response)
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

        // The controller returns the bare string "ok" on success and an
        // {error: "..."} body on rejected input (uuid:24c35056). Both are
        // truthy, so a plain truthiness check would read a rejected input as
        // success; _unwrap() throws instead so callers stop believing the
        // cadence changed when it did not.
        return this._unwrap(response)
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

        // Verify if there is a result and return it (throws on an {error} envelope)
        return this._unwrap(response)
    }

    // Pin the coin node's clock to `timestamp` (unix seconds) through the miner,
    // so the NEXT generateBlocks stamps its block at that time; pass 0 to release
    // the mock clock. The parity driver is node-RPC-free by design (some installs
    // don't publish the node), so it reaches setmocktime through the miner, which
    // owns the node connection. Refused on mainnet by the miner.
    async setMockTime(timestamp){
        const data = {
            jsonrpc: '2.0',
            method: 'set_mock_time',
            params: {"timestamp": timestamp},
            id: 1
        }

        let response
        try {
            response = await axios.post(this.url, data, this.reqConfig)

            // "ok" on success, {error:"..."} on refusal (mainnet / bad input); both
            // truthy, so _unwrap throws on the error envelope rather than reporting a
            // clock pin that never happened.
            return this._unwrap(response)
        } catch (e) {
            // Miner sidecars predating set_mock_time answer "Method not found", and a
            // long-lived venue routinely runs one chain's miner older than another's
            // (one venue's LTC/DOGE miners lagged BTC's by days). Every clock-driven
            // drill family would then be BTC-only for a reason that has nothing to do
            // with the chain. setmocktime is a node-level control, so going straight to
            // the node produces the identical effect where its RPC port is published;
            // where it is not, the original miner error stands.
            if (!this._isMissingMethod(e) || !global.nodeConnector)
                throw e
            if (!RegtestMinerConnector._mockTimeFallbackAnnounced) {
                RegtestMinerConnector._mockTimeFallbackAnnounced = true
                console.log('RegtestMinerConnector: miner has no set_mock_time; ' +
                    'driving setmocktime through the node RPC instead')
            }
            return await global.nodeConnector._rpc('setmocktime', [Number(timestamp)])
        }
    }

    // A miner that does not implement the method, as opposed to one that refused the
    // call. Matched on the JSON-RPC message because the sidecar answers "Method not
    // found - set_mock_time" with a 200, so there is no status code to key on.
    _isMissingMethod(e){
        return /method not found/i.test(String(e && e.message))
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

        return this._unwrap(response)
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

        return this._unwrap(response)
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

        return this._unwrap(response)
    }

    // Turn the miner's mine-empty heartbeat on (ms) or off (0). The miner is
    // mempool-driven, so an idle chain gains no height and a test that WAITS OUT
    // a height window (stake ACTIVATION_DELAY_BLOCKS, confirmation depth) hangs
    // with nothing in flight to make a block. generateBlocks jumps such a window;
    // this lets the chain advance on its own while the test observes.
    // Always pair an enable with a disable, or the extra blocks perturb
    // depth/reorg assertions later in the run.
    async setIdleMineInterval(intervalMs){
        const data = {
            jsonrpc: '2.0',
            method: 'set_idle_mine_interval',
            params: {interval_ms: intervalMs},
            id: 1
        }

        const response = await axios.post(this.url, data, this.reqConfig)

        return this._unwrap(response)
    }
}

module.exports = RegtestMinerConnector