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
 * P3(b): deterministic bootstrap, a TRIMMED replacement for
 * test/initialCheck.test.js (use as the mocha --require for the parity suite).
 *
 * initialCheck cannot be used for the parity run for two reasons, both of
 * which break the determinism contract:
 *   1. its service-pings phase pings the COIN NODE and throws if it is not
 *      host-reachable (some installs, e.g. this VM's bitcoin, do NOT publish
 *      the node RPC. The parity driver is node-RPC-free by design, so we
 *      simply do not ping the node here.
 *   2. its gas-token-check AUTO-ISSUES the XCHAIN gas token on a fresh chain
 *      at a TIMING-DEPENDENT height, a pre-baseline protocol action that
 *      forks the cumulative consensus hash chain across chains. We do NOT
 *      auto-create gas; the parity suite issues XCHAIN itself as PINNED
 *      corpus step 0 (deterministic, part of the parity set).
 *
 * What it DOES set up (only the published services the driver needs):
 *   global.regtestMinerConnector, global.utxoTrackerConnector,
 *   global.indexerDatabase (+ .pool), global.COIN/NETWORK/NETWORK_OBJECT.
 * Endpoints + the indexer DB credentials are discovered from the hub config
 * (same source initialCheck uses) so no secret is ever written here.
 *********************************************************************/

const dotenv = require('dotenv');
dotenv.config();

const XChainUtxoTrackerConnector = require('../../src/XChainUtxoTrackerConnector.js');
const XChainHubConnector = require('../../src/XChainHubConnector.js');
const RegtestMinerConnector = require('../../src/RegtestMinerConnector.js');
const Database = require('../../src/db.js');
const CryptoNetworks = require('../../src/CryptoNetworks');

global.COIN = process.env.COIN;
global.NETWORK = process.env.NETWORK;
if (COIN == null) {
    const parts = String(NETWORK || '').split('-');
    global.COIN = parts[0];
    global.NETWORK = parts[1];
}
global.NETWORK_OBJECT = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK);
const COIN_CODE_MAP = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' };
global.COIN_CODE = COIN_CODE_MAP[COIN] || String(COIN).toUpperCase().slice(0, 3);

exports.mochaHooks = {
    async beforeAll() {
        if (NETWORK === 'mainnet') throw new Error('Refusing to run parity against mainnet.');

        // The hub config reports CONTAINER-INTERNAL endpoints (e.g. mariadb:3306,
        // miner:3005). A host-run reaches services via their PUBLISHED host ports,
        // which the hub does not know, so connection ports/hosts come from env
        // (the standard e2e var names), while the indexer DB CREDENTIALS (which we
        // must not hardcode) are pulled from the hub config. No secret is logged.
        console.log('[parityBoot] discovering indexer DB credentials from the hub for ' + COIN + '/' + NETWORK);
        const hubConnector = new XChainHubConnector(XChainHubConnector.parseEndpoints());
        if (!(await hubConnector.ping())) {
            const f = (hubConnector.lastFailures || []).join(', ');
            throw new Error("[parityBoot] can't reach the XChain hub" + (f ? ' [' + f + ']' : ''));
        }
        const cfg = await hubConnector.getAllConfig();
        if (!cfg || !cfg[COIN] || !cfg[COIN][NETWORK]) {
            throw new Error('[parityBoot] hub returned no config for ' + COIN + '/' + NETWORK);
        }
        const ix = cfg[COIN][NETWORK]['xchain-indexer'];

        const minerPort = process.env.REGTEST_MINER_API_PORT;
        const trackerPort = process.env.UTXO_TRACKER_API_PORT;
        const dbHost = process.env.DATABASE_URL || '127.0.0.1';
        const dbPort = parseInt(process.env.DATABASE_PORT, 10) || 13306;
        if (!minerPort || !trackerPort) {
            throw new Error('[parityBoot] set REGTEST_MINER_API_PORT + UTXO_TRACKER_API_PORT (published host ports)');
        }
        // Credentials are HUB-AUTHORITATIVE (per-coin). The generic INDEXER_DB_*
        // env names are NOT honoured here: dotenv loads the e2e .env, whose
        // single-coin INDEXER_DB_NAME (e.g. BTC's) would silently override the
        // hub-discovered per-coin DB. That override once pointed an entire DOGE run at
        // the BTC indexer DB (instant height waits, BTC data digested as DOGE,
        // trivially "identical" hash chains). Deliberate overrides use the
        // PARITY_-prefixed names, which no shared .env defines.
        const dbName = process.env.PARITY_INDEXER_DB_NAME || ix['name'];
        const dbUser = process.env.PARITY_INDEXER_DB_USER || ix['user'];
        const dbPass = process.env.PARITY_INDEXER_DB_PASS || ix['pass'];
        // The hub names per-coin DBs XChain_<CODE>_<Network>_<Service>. Refuse
        // to run if the resolved DB does not belong to this run's coin.
        if (!String(dbName).toUpperCase().includes(global.COIN_CODE)) {
            throw new Error('[parityBoot] indexer DB "' + dbName + '" does not match coin ' +
                global.COIN_CODE + ': wrong-DB guard (stale env override or bad hub config)');
        }
        console.log('[parityBoot] indexer DB: ' + dbName);

        global.regtestMinerConnector = new RegtestMinerConnector('localhost', minerPort, process.env.MINER_API_KEY || null);
        global.utxoTrackerConnector = new XChainUtxoTrackerConnector('localhost', trackerPort);
        global.indexerDatabase = new Database(dbHost, dbPort, dbName, dbUser, dbPass);

        // Ping ONLY the services the driver uses; never the node or explorer.
        if (!(await global.utxoTrackerConnector.ping())) throw new Error('[parityBoot] utxo-tracker unreachable');
        if (!(await global.regtestMinerConnector.waitForReady(60000, 1000))) throw new Error('[parityBoot] regtest-miner not ready after 60s');
        if (!(await global.indexerDatabase.ping())) throw new Error('[parityBoot] indexer DB unreachable');

        console.log('[parityBoot] ready: miner/tracker/indexer-DB connected; NO node-ping, NO gas-genesis');
    },

    async afterAll() {
        try { if (global.indexerDatabase && global.indexerDatabase.pool) await global.indexerDatabase.pool.end(); }
        catch (e) { /* best effort */ }
    },
};
