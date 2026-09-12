/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * E2E test helper: mock indexer source for the XBRIDGE federation (indexer stand-in).
 *
 * A tiny in-process HTTP JSON-RPC server answering the three reads
 * CrossChainBridgeEngine makes of a chain's indexer:
 *
 *   getpendingbridgetransfers -> { latest_block_index, network, count, transfers }
 *   gettokenpolicy            -> { allow_list, block_list, sleeping, policy_hash,
 *                                  bridged, origin_block }
 *   getlatestblock            -> { block_index }
 *
 * Byte-faithful to xchain-indexer/src/api.js, which is the contract the engine polls.
 *
 * WHY AN HTTP MOCK rather than monkeypatching the engine, the reason
 * mockCrossChainOfferBook gives for the DEX: the federation proof rests on every FOLLOWER
 * independently re-fetching the leg in validateProposedMatch -> _validateTransfer ->
 * _indexerCall before it will co-sign a leader's proposed row. Serving real HTTP keeps the
 * engine's actual network path intact, and per-path sources let ONE validator be pointed at
 * a divergent source (the byzantine case) while the honest majority shares one.
 *
 * Sources are keyed by URL path: POST /pending/<name>/<COIN> answers <name>'s view of
 * <COIN>. Point each hub's engine.indexers[COIN].url at a name/coin path; repoint one hub
 * to a different name to make it byzantine.
 ********************************************************************/

'use strict';

const http = require('http');

class BridgePendingSource {

    constructor(){
        // name -> { network, latestBlockIndex, transfersByCoin, policiesByCoin }
        this.sources   = new Map();
        this.server    = null;
        this.port      = null;
        this._reqCount = 0;          // observability: how many polls the engines made
    }

    /**
     * Register or replace a named source.
     *
     * @param name                      the path segment hubs are pointed at
     * @param opts.network              the network every answer declares
     * @param opts.latestBlockIndex     the chain tip every answer reports; with a leg's
     *                                  block_index it decides the confirmation depth the
     *                                  engine computes, which is the only depth gate
     * @param opts.transfersByCoin      { COIN: [ pending leg, ... ] }
     * @param opts.policiesByCoin       { COIN: { TICK: gettokenpolicy answer } }
     */
    setPending(name, opts){
        const o = opts || {};
        this.sources.set(name, {
            network:          o.network || 'regtest',
            latestBlockIndex: o.latestBlockIndex === undefined ? 200 : o.latestBlockIndex,
            transfersByCoin:  o.transfersByCoin || {},
            policiesByCoin:   o.policiesByCoin  || {}
        });
    }

    start(){
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => this._handle(req, res));
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                this.port = this.server.address().port;
                resolve({ url: 'http://127.0.0.1:' + this.port, port: this.port });
            });
        });
    }

    stop(){
        return new Promise((resolve) => {
            if(!this.server) return resolve();
            try { this.server.closeAllConnections && this.server.closeAllConnections(); } catch(_){}
            this.server.close(() => resolve());
            this.server = null;
        });
    }

    // The URL a hub's engine.indexers[COIN].url is set to.
    urlFor(name, coin){ return 'http://127.0.0.1:' + this.port + '/pending/' + name + '/' + coin; }

    // How many RPC calls every engine has made against this source, for a drill that needs
    // to prove the followers really re-read rather than trusting the leader.
    requestCount(){ return this._reqCount; }

    _handle(req, res){
        const m = /^\/pending\/([^/]+)\/([^/]+)\/?$/.exec(req.url || '');
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            this._reqCount++;
            let rpcId = 1, method = '', params = {};
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                rpcId  = body.id != null ? body.id : 1;
                method = String(body.method || '');
                params = body.params || {};
            } catch(_){ /* a malformed body answers the unknown-method shape below */ }

            const payload = JSON.stringify({
                jsonrpc: '2.0', id: rpcId,
                result: this._result(m, method, params)
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(payload);
        });
    }

    _result(match, method, params){
        if(!match) return { error: 'unknown source path' };
        const name = match[1], coin = match[2];
        const src  = this.sources.get(name);
        // An unregistered source answers an EMPTY view rather than an error: that is what a
        // live indexer with nothing pending looks like, and it is the state a drill wants
        // when it proves a round does not run.
        if(!src) return { latest_block_index: 0, network: '', count: 0, transfers: [] };

        if(method === 'getpendingbridgetransfers'){
            const transfers = (src.transfersByCoin[coin] || []).slice();
            return {
                latest_block_index: src.latestBlockIndex,
                network:            src.network,
                count:              transfers.length,
                transfers:          transfers
            };
        }
        if(method === 'gettokenpolicy'){
            const byTick = src.policiesByCoin[coin] || {};
            const policy = byTick[String(params.tick || '')];
            if(!policy) return { error: 'tick has no native row on this chain' };
            return Object.assign({}, policy, { origin_block: Number(params.origin_block) });
        }
        if(method === 'getlatestblock'){
            return { block_index: src.latestBlockIndex };
        }
        return { error: 'unsupported method ' + method };
    }

    /**
     * One pending leg, byte-faithful to api.js getpendingbridgetransfers' row mapping.
     * Every field is spelled out by the caller: a builder that defaulted the fields the
     * federation re-validates (tick, decimals, amount, addresses) would let a drill pass
     * while proving nothing about them.
     */
    static makeLeg(f){
        return {
            transfer_kind:    f.transfer_kind,
            src_chain:        f.src_chain,
            src_action_index: Number(f.src_action_index),
            src_address:      f.src_address,
            dest_chain:       f.dest_chain,
            dest_address:     f.dest_address,
            tick:             f.tick,
            decimals:         Number(f.decimals),
            amount:           String(f.amount),
            min_depth:        Number(f.min_depth || 0),
            block_index:      Number(f.block_index),
            confirmations:    Number(f.confirmations || 0),
            tx_hash:          f.tx_hash || ('txhash_' + f.src_action_index),
            push_generation:  Number(f.push_generation || 0)
        };
    }
}

module.exports = { BridgePendingSource };
