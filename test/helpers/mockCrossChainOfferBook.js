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
 * E2E test helper: Mock cross-chain offer book (indexer stand-in)
 *
 * A tiny in-process HTTP JSON-RPC server that answers `getopencrosschainorders`
 * exactly like xchain-indexer's api.js:393: `{ latest_block_index, network,
 * count, orders }`, so a CrossChainDexEngine can discover + independently
 * re-validate matches with NO real indexer behind it.
 *
 * Why an HTTP mock (vs monkeypatching the engine): the DEX federation proof
 * hinges on every follower INDEPENDENTLY re-fetching the book in
 * validateProposedMatch -> _findOpenOffer -> _indexerCall before it will sign a
 * leader's proposed match. Serving over real HTTP keeps the engine's actual
 * network path intact, and per-path "books" let one validator be pointed at a
 * DIVERGENT book (the byzantine case) while the honest majority shares one.
 *
 * Books are keyed by URL path: POST /book/<name>/<COIN> returns <name>'s offers
 * for <COIN>. The harness points each hub's engine.indexers[COIN].url at a
 * book/coin path; repoint one hub to a different <name> to make it byzantine.
 *
 * Offer-row shape is byte-faithful to the indexer (see db.js getOpenCrossChain
 * Swaps:5030 / getOpenCrossChainOrders:5105). The engine ignores give_remaining/
 * get_remaining (it derives remaining from its own committed ledger), but we
 * emit them for fidelity.
 ********************************************************************/

'use strict';

const http = require('http');

class MockCrossChainOfferBook {

    constructor(){
        // name -> { network, latestBlockIndex, ordersByCoin: { LTC:[...], DOGE:[...] } }
        this.books  = new Map();
        this.server = null;
        this.port   = null;
        this._reqCount = 0;          // observability: how many polls the engines made
    }

    // Register / replace a named book. ordersByCoin maps COIN -> array of offers
    // (built via makeOrder/makeSwap). Missing coins serve an empty book.
    setBook(name, { network = 'regtest', latestBlockIndex = 200, ordersByCoin = {} } = {}){
        this.books.set(name, { network, latestBlockIndex, ordersByCoin });
    }

    // Start listening on an ephemeral port. Returns { url } where url is the
    // base (callers append /book/<name>/<COIN>).
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

    // Full URL for a given book + coin: what a hub's engine.indexers[COIN].url is set to.
    urlFor(name, coin){ return 'http://127.0.0.1:' + this.port + '/book/' + name + '/' + coin; }

    _handle(req, res){
        // Only serves getopencrosschainorders (the sole method the engine calls on these URLs).
        let m = /^\/book\/([^/]+)\/([^/]+)\/?$/.exec(req.url || '');
        let chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            this._reqCount++;
            let rpcId = 1;
            try { let body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); rpcId = body.id != null ? body.id : 1; } catch(_){}
            let result;
            if(!m){
                result = { error: 'unknown book path' };
            } else {
                let name = m[1], coin = m[2];
                let book = this.books.get(name);
                if(!book){
                    result = { latest_block_index: 0, network: '', count: 0, orders: [] };
                } else {
                    let orders = (book.ordersByCoin[coin] || []).slice();
                    result = {
                        latest_block_index: book.latestBlockIndex,
                        network:            book.network,
                        count:              orders.length,
                        orders:             orders
                    };
                }
            }
            let payload = JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: result });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(payload);
        });
    }
}

// Offer builders (byte-faithful to the indexer's mapped rows)

// A cross-chain ORDER offer on `home_coin`. `give`/`get` are { coin, tick, amount,
// ownership } describing the give leg (escrowed by the maker) and the get leg.
function makeOrder({ action_index, give, get, get_address, block_index = 100,
                     give_remaining = null, get_remaining = null }){
    return {
        kind:           'order',
        action_index:   Number(action_index),
        give_coin:      give.coin,
        give_tick:      give.tick || null,
        give_amount:    give.ownership ? '1' : String(give.amount),
        give_remaining: String(give_remaining != null ? give_remaining : (give.ownership ? '1' : give.amount)),
        give_ownership: Number(give.ownership || 0),
        get_coin:       get.coin,
        get_tick:       get.tick || null,
        get_amount:     get.ownership ? '1' : String(get.amount),
        get_remaining:  String(get_remaining != null ? get_remaining : (get.ownership ? '1' : get.amount)),
        get_ownership:  Number(get.ownership || 0),
        get_address:    get_address,
        source:         'src_' + action_index,
        expiration:     0,
        allow_list:     null,
        block_list:     null,
        block_index:    Number(block_index)
    };
}

// A cross-chain SWAP offer (Phase A, exact single-fill). Same shape, kind='swap',
// no remaining fields.
function makeSwap({ action_index, give, get, get_address, block_index = 100 }){
    return {
        kind:           'swap',
        action_index:   Number(action_index),
        give_coin:      give.coin,
        give_tick:      give.tick || null,
        give_amount:    give.ownership ? '1' : String(give.amount),
        give_ownership: Number(give.ownership || 0),
        get_coin:       get.coin,
        get_tick:       get.tick || null,
        get_amount:     get.ownership ? '1' : String(get.amount),
        get_ownership:  Number(get.ownership || 0),
        get_address:    get_address,
        source:         'src_' + action_index,
        expiration:     0,
        allow_list:     null,
        block_list:     null,
        block_index:    Number(block_index)
    };
}

module.exports = { MockCrossChainOfferBook, makeOrder, makeSwap };
