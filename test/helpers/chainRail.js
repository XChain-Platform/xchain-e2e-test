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
 * MULTI-CHAIN RAIL: run the single-chain e2e helpers against a SECOND coin
 * inside one process.
 *
 * Every helper in this suite (cryptoHelper, transactionHelper, gasHelper,
 * stakeHelper, vmHelper, attestationHelper, nativeFeeHelper) reaches its stack
 * through the globals initialCheck sets: COIN/NETWORK/COIN_CODE plus the seven
 * connectors and indexerDatabase. That is fine for a suite that lives on one
 * chain and it is why test/sdk/** has been BTC-only in practice; a drill that
 * has to interleave legs on two chains in one flow (an ATTEST v0 on LTC, its
 * materialized v3 on BTC, the v1 back on BTC, the v4 back on LTC) cannot use a
 * per-run env file the way test/sdk/dexDogeSetup.js does.
 *
 * A rail is that same global set, captured as an object. `withRail(rail, fn)`
 * swaps the globals in, runs fn, and restores them, so EVERY existing helper
 * works verbatim on the second chain with no fork of its logic. Two details
 * make that honest rather than a trick:
 *
 *   1. Endpoints come from env (published HOST ports; the hub only knows the
 *      container-internal ones), while node RPC and indexer DB CREDENTIALS are
 *      discovered from the hub, exactly as test/parity/parityBoot.js does. No
 *      secret is written here or logged.
 *   2. Helpers that MEMOIZE per-chain state are dropped from the require cache
 *      on every swap. nativeFeeHelper caches the resolved fee mode + fee
 *      destination in a module-level `_feeMode`; carrying BTC's destination
 *      onto LTC would attach a fee output paying the wrong address, and every
 *      fee-bearing action on the second chain would index
 *      `invalid: insufficient fee`. Consumers require it lazily inside their
 *      functions, so dropping the cache entry is enough.
 *
 * The node RPC is part of the rail and IS probed by railFailures, because
 * transactionHelper broadcasts through it: a stale hub-stored password answers
 * 401 and the only symptom a caller sees is "the sent tx didn't appear in the
 * blockchain". Credentials therefore prefer the environment and the per-chain
 * .env.<code> file over the hub's install-time copy.
 ********************************************************************/

'use strict';

const BlockchainConnector        = require('../../src/BlockchainConnector.js');
const XChainUtxoTrackerConnector = require('../../src/XChainUtxoTrackerConnector.js');
const XChainEncoderConnector     = require('../../src/XChainEncoderConnector.js');
const XChainDecoderConnector     = require('../../src/XChainDecoderConnector.js');
const XChainIndexerConnector     = require('../../src/XChainIndexerConnector.js');
const XChainExplorerConnector    = require('../../src/XChainExplorerConnector.js');
const XChainHubConnector         = require('../../src/XChainHubConnector.js');
const RegtestMinerConnector      = require('../../src/RegtestMinerConnector.js');
const Database                   = require('../../src/db.js');
const CryptoNetworks             = require('../../src/CryptoNetworks');

const COIN_CODE_MAP = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' };

// Published host ports of an `xchain-node` multi-coin regtest stack. These match
// the port blocks the suite's own .env / .env.ltc / .env.doge already use, so a
// standard stack needs no extra configuration; anything non-standard is set per
// coin code (LTC_ENCODER_API_PORT, DOGE_INDEXER_API_PORT, ...).
const DEFAULT_PORTS = {
    BTC:  { node: 3020, tracker: 3021, decoder: 3022, encoder: 3023, indexer: 3024, miner: 3025 },
    LTC:  { node: 3220, tracker: 3221, decoder: 3222, encoder: 3223, indexer: 3224, miner: 3225 },
    DOGE: { node: 3120, tracker: 3121, decoder: 3122, encoder: 3123, indexer: 3124, miner: 3125 },
};

// Globals a rail owns. Restoring exactly this list is what makes withRail safe
// to nest inside a suite bootstrapped by initialCheck.
const RAIL_GLOBALS = [
    'COIN', 'NETWORK', 'NETWORK_OBJECT', 'COIN_CODE',
    'nodeConnector', 'utxoTrackerConnector', 'encoderConnector', 'decoderConnector',
    'indexerConnector', 'explorerConnector', 'indexerDatabase', 'regtestMinerConnector',
];

// Env vars a rail owns, because a helper reads them directly rather than through
// a global (hubMirrorTopology.localParams -> the price-snapshot fixtures).
const RAIL_ENV = ['COIN', 'NETWORK', 'INDEXER_DB_NAME', 'INDEXER_DB_USER', 'INDEXER_DB_PASS'];

// Helper modules that memoize chain-specific state at module scope.
const MEMOIZING_HELPERS = [
    require.resolve('./nativeFeeHelper'),
    require.resolve('./priceSnapshotHelper'),
    require.resolve('./hubMirrorTopology'),
];

function envPort(code, key, fallback) {
    const v = process.env[code + '_' + key];
    return v ? parseInt(v, 10) : fallback;
}

// Per-chain env file (.env.ltc / .env.doge), the shape this suite already uses to
// run a second coin. Parsed, never loaded into process.env, so it cannot shadow
// the running chain's own settings.
function readChainEnvFile(code) {
    const path = require('path');
    const fs = require('fs');
    const file = path.resolve(__dirname, '../../.env.' + String(code).toLowerCase());
    if (!fs.existsSync(file)) return {};
    try { return require('dotenv').parse(fs.readFileSync(file)); }
    catch (e) { return {}; }
}

// Node RPC credentials, in precedence order:
//   1. <CODE>_NODE_USER / <CODE>_NODE_PASSWORD in the environment
//   2. NODE_USER / NODE_PASSWORD from .env.<code>
//   3. the hub's stored node credentials
// The hub is LAST on purpose: its copy is written at install time and goes stale
// whenever the node's conf is regenerated, which surfaces as a 401 deep inside a
// broadcast rather than at startup (the documented hub-auto-discovery trap).
function resolveNodeCreds(code, chainEnv, hubNode) {
    const user = process.env[code + '_NODE_USER'] || chainEnv.NODE_USER || (hubNode && hubNode.user);
    const pass = process.env[code + '_NODE_PASSWORD'] || chainEnv.NODE_PASSWORD || (hubNode && hubNode.pass);
    return { user, pass };
}

// Build a rail for `coin` on `network`, discovering the node RPC + indexer DB
// credentials from the hub. Throws (never silently degrades) when the hub has no
// config for the coin: a rail built on guessed credentials would fail later, deep
// inside a broadcast, with an error that names neither the coin nor the cause.
async function createRail(coin, network = 'regtest', opts = {}) {
    const code = COIN_CODE_MAP[coin] || String(coin).toUpperCase().slice(0, 3);
    const host = process.env[code + '_SERVICE_HOST'] || opts.host || 'localhost';
    const ports = DEFAULT_PORTS[code] || {};

    const hub = new XChainHubConnector(XChainHubConnector.parseEndpoints());
    if (!(await hub.ping())) {
        const f = (hub.lastFailures || []).join(', ');
        throw new Error('[chainRail] hub unreachable, cannot discover ' + code + ' credentials' + (f ? ' [' + f + ']' : ''));
    }
    const cfg = await hub.getAllConfig();
    if (!cfg || !cfg[coin] || !cfg[coin][network])
        throw new Error('[chainRail] hub has no config for ' + coin + '/' + network);
    const svc = cfg[coin][network];
    const ix = svc['xchain-indexer'] || {};
    const chainEnv = readChainEnvFile(code);
    const nodeCreds = resolveNodeCreds(code, chainEnv, svc['node']);

    const dbHost = process.env.DATABASE_URL || '127.0.0.1';
    const dbPort = parseInt(process.env.DATABASE_PORT, 10) || 13306;

    // Wrong-DB guard, same rule parityBoot uses: the hub names per-coin databases
    // XChain_<CODE>_<Network>_<Service>, so a name that does not carry this coin's
    // code means stale config and every later wait would watch the wrong chain.
    if (!String(ix.name || '').toUpperCase().includes(code))
        throw new Error('[chainRail] indexer DB "' + ix.name + '" does not belong to ' + code);

    const rail = {
        coin, network, code,
        host,
        ports: {
            node:    envPort(code, 'NODE_PORT', ports.node),
            tracker: envPort(code, 'UTXO_TRACKER_API_PORT', ports.tracker),
            decoder: envPort(code, 'DECODER_API_PORT', ports.decoder),
            encoder: envPort(code, 'ENCODER_API_PORT', ports.encoder),
            indexer: envPort(code, 'INDEXER_API_PORT', ports.indexer),
            miner:   envPort(code, 'REGTEST_MINER_API_PORT', ports.miner),
            explorer: parseInt(process.env.EXPLORER_API_PORT, 10) || 18080,
        },
        db: { host: dbHost, port: dbPort, name: ix.name, user: ix.user, pass: ix.pass },
        globals: null,
    };

    rail.globals = {
        COIN:           coin,
        NETWORK:        network,
        NETWORK_OBJECT: CryptoNetworks.getBitcoinJsNetwork(coin + '-' + network),
        COIN_CODE:      code,
        nodeConnector:         new BlockchainConnector(host, rail.ports.node, nodeCreds.user, nodeCreds.pass),
        utxoTrackerConnector:  new XChainUtxoTrackerConnector(host, rail.ports.tracker),
        encoderConnector:      new XChainEncoderConnector(host, rail.ports.encoder),
        decoderConnector:      new XChainDecoderConnector(host, rail.ports.decoder),
        indexerConnector:      new XChainIndexerConnector(host, rail.ports.indexer, process.env[code + '_INDEXER_API_KEY'] || process.env.INDEXER_API_KEY || null),
        explorerConnector:     new XChainExplorerConnector(host, rail.ports.explorer),
        indexerDatabase:       new Database(dbHost, dbPort, ix.name, ix.user, ix.pass),
        regtestMinerConnector: new RegtestMinerConnector(host, rail.ports.miner, process.env[code + '_MINER_API_KEY'] || process.env.MINER_API_KEY || null),
    };

    rail.env = {
        COIN:            coin,
        NETWORK:         network,
        INDEXER_DB_NAME: ix.name,
        INDEXER_DB_USER: ix.user,
        INDEXER_DB_PASS: ix.pass,
    };

    return rail;
}

// Reachability probe for the services the drill actually drives. Returns a list
// of human-readable failures (empty when the rail is usable), so a caller can
// SKIP on an unavailable venue instead of failing a run that never had a chance.
async function railFailures(rail) {
    const out = [];
    try { if (!(await rail.globals.utxoTrackerConnector.ping())) out.push('utxo-tracker'); }
    catch (e) { out.push('utxo-tracker (' + e.message + ')'); }
    try { if (!(await rail.globals.regtestMinerConnector.waitForReady(20000, 1000))) out.push('regtest-miner'); }
    catch (e) { out.push('regtest-miner (' + e.message + ')'); }
    try { if (!(await rail.globals.encoderConnector.ping())) out.push('encoder'); }
    catch (e) { out.push('encoder (' + e.message + ')'); }
    try { if (!(await rail.globals.indexerDatabase.ping())) out.push('indexer-db'); }
    catch (e) { out.push('indexer-db (' + e.message + ')'); }
    // The node RPC is checked HERE rather than left to fail mid-broadcast: every
    // action this rail sends goes out through nodeConnector.broadcastTx, and a 401
    // from a stale hub-stored password otherwise surfaces as "the sent tx didn't
    // appear in the blockchain", which names neither the port nor the cause.
    try { await rail.globals.nodeConnector.getNetworkInfo(); }
    catch (e) {
        out.push('node RPC ' + rail.host + ':' + rail.ports.node + ' (' + e.message +
                 '; set ' + rail.code + '_NODE_USER/' + rail.code + '_NODE_PASSWORD or keep .env.' +
                 String(rail.code).toLowerCase() + ' current)');
    }
    return out;
}

function purgeMemoizingHelpers() {
    for (const id of MEMOIZING_HELPERS) delete require.cache[id];
}

// Install a rail's globals + env, returning the previous values so they can be
// put back verbatim (including `undefined` for a name that was never set).
function enterRail(rail) {
    const saved = { globals: {}, env: {} };
    for (const k of RAIL_GLOBALS) saved.globals[k] = global[k];
    for (const k of RAIL_ENV) saved.env[k] = process.env[k];

    for (const k of RAIL_GLOBALS) global[k] = rail.globals[k];
    for (const k of RAIL_ENV) {
        if (rail.env[k] === undefined) delete process.env[k];
        else process.env[k] = String(rail.env[k]);
    }
    purgeMemoizingHelpers();
    return saved;
}

function exitRail(saved) {
    for (const k of RAIL_GLOBALS) global[k] = saved.globals[k];
    for (const k of RAIL_ENV) {
        if (saved.env[k] === undefined) delete process.env[k];
        else process.env[k] = saved.env[k];
    }
    purgeMemoizingHelpers();
}

// Run `fn` with `rail` installed. Always restores, including on throw, so one
// failing leg cannot leave the rest of the suite pointed at the wrong chain.
async function withRail(rail, fn) {
    const saved = enterRail(rail);
    try { return await fn(rail); }
    finally { exitRail(saved); }
}

// Capture the CURRENT globals as a rail, so the chain initialCheck bootstrapped
// can be re-entered by the same mechanism as any other.
function captureCurrentRail() {
    const globals = {};
    for (const k of RAIL_GLOBALS) globals[k] = global[k];
    const env = {};
    for (const k of RAIL_ENV) env[k] = process.env[k];
    return {
        coin: global.COIN, network: global.NETWORK, code: global.COIN_CODE,
        host: process.env.INDEXER_URL || 'localhost',
        ports: {
            indexer: parseInt(process.env.INDEXER_API_PORT, 10) || 3024,
            miner:   parseInt(process.env.REGTEST_MINER_API_PORT, 10) || 3025,
        },
        db: {
            host: process.env.DATABASE_URL || '127.0.0.1',
            port: parseInt(process.env.DATABASE_PORT, 10) || 13306,
            name: process.env.INDEXER_DB_NAME,
            user: process.env.INDEXER_DB_USER,
            pass: process.env.INDEXER_DB_PASS,
        },
        globals, env,
    };
}

module.exports = {
    COIN_CODE_MAP,
    DEFAULT_PORTS,
    createRail,
    railFailures,
    withRail,
    enterRail,
    exitRail,
    captureCurrentRail,
};
