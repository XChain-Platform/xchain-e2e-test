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
 * XChain End-to-End Test Suite - UTXO Tracker Connector
 *
 * This file handles connecting to XChain UTXO tracker instances
 *
 ********************************************************************/

const axios = require('axios')

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

        try {
            const response = await axios.post(this.url, data, {
                headers: { 'Content-Type': 'application/json' }
            });

            const responseData = response.data;

            if (responseData.result) {
                return true;
            } else {
                return false;
            }
        } catch (error) {
            return false;
        }
    }

    async getSyncStatus(){
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'get_sync_status',
                id: 1
            };
            const response = await axios.post(this.url, data, {
                headers: { 'Content-Type': 'application/json' }
            });
            const responseData = response.data;
            return responseData.result === undefined ? null : responseData.result;
        } catch (error) {
            return null;
        }
    }

    // Single-shot probe: returns the tracker's is_quiescent payload
    // (or null on RPC error). Caller waits via quiesce() below.
    async getQuiescentStatus(){
        try {
            const data = { jsonrpc: '2.0', method: 'is_quiescent', id: 1 };
            const response = await axios.post(this.url, data, {
                headers: { 'Content-Type': 'application/json' }
            });
            const responseData = response.data;
            return responseData.result === undefined ? null : responseData.result;
        } catch (error) {
            return null;
        }
    }

    // Test framework barrier: polls tracker.is_quiescent until ready or
    // timeout. Pre-test/afterEach hooks call this so the next test starts
    // from a fully-settled stack (no mid-batch state, no mempool backlog).
    //
    // When something is still in flight, optionally nudge it forward by
    // mining a block via the regtest miner. This confirms any straggling
    // mempool tx and pushes the tracker into committing the latest batch.
    // Deliberately does NOT throw on timeout: transactionHelper.submit and
    // anchorElection drive it inside retry loops and need the status object back
    // to decide whether to retry. The hook that must fail on a non-ready status
    // is the root afterEach in test/initialCheck.test.js, and mineErrors below is
    // what makes such a failure diagnosable.
    async quiesce({ timeoutMs = 30000, pollMs = 250, regtestMiner = null } = {}){
        const deadline = Date.now() + timeoutMs
        let last = null
        let mineErrors = 0
        let lastMineError = null
        while (Date.now() < deadline){
            const status = await this.getQuiescentStatus()
            last = status
            if (status && status.ready) return this._withMineErrors(status, mineErrors, lastMineError)
            // Not ready yet: if a regtestMiner was passed, mine a block to
            // unblock mempool/batch progression.
            if (regtestMiner && status && status.mempool_size > 0){
                // Count and report the failed nudge rather than discarding it. A
                // silently swallowed mine is the single likeliest cause of a barrier
                // that never reaches quiescence, and it used to leave no trace at
                // all: the caller saw only ready=false with no reason.
                try {
                    await regtestMiner.generateBlocks(1)
                } catch (e) {
                    mineErrors++
                    lastMineError = (e && e.message) ? e.message : String(e)
                    console.warn('quiesce: nudge mine failed: ' + lastMineError)
                }
            }
            await this.sleep(pollMs)
        }
        // Last status seen, which may carry ready=false. Callers that are a barrier
        // rather than a retry loop must inspect .ready; the root afterEach does.
        return this._withMineErrors(last, mineErrors, lastMineError)
    }

    // Attach the nudge-failure tally to whatever quiesce returns, without
    // rewriting a null status into an object (callers distinguish no-response
    // from a status body).
    _withMineErrors(status, mineErrors, lastMineError){
        if (!status || typeof status !== 'object') return status
        status.mineErrors = mineErrors
        if (lastMineError) status.lastMineError = lastMineError
        return status
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

            const response = await axios.post(this.url, data, {
                headers: { 'Content-Type': 'application/json' }
            });

            const responseData = response.data;

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
