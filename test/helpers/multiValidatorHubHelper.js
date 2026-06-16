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
 * E2E test helper — Multi-Validator Hub Harness
 *
 * Spins up N XChainHub instances in-process, each with its own:
 *   - MariaDB hub DB (auto-bootstrapped via hub.start())
 *   - Ed25519 signing keypair
 *   - P2P_PORT + cross-referenced SEED_NODES
 *
 * Used to drive real PBFT consensus across multiple validators in tests:
 *   ATTEST_PROPOSE → ATTEST_PREPARE → ATTEST_COMMIT → on-chain
 *   ATTEST v1 (response) published by the leader → indexer callback.
 *
 * Unlike MockAttestationValidator (which signs in-process but bypasses
 * the hub entirely), this harness exercises the full validator pipeline.
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md §16 Phase 3
 *
 ********************************************************************/

'use strict';

const path = require('path');
const fs   = require('fs');
const net  = require('net');
const mariadb = require('mariadb');

// Locate the xchain-hub package. Lives adjacent in the monorepo
// (host-process dev), under xchain-node's modules/, or staged into the
// e2e build context by LIBRARY_BUNDLES (in-container at /XChainE2ETest/
// xchain-hub/). Try a few well-known locations or accept an explicit override.
function _resolveHubFile(rel){
    const candidates = [
        process.env.XCHAIN_HUB_PATH && path.join(process.env.XCHAIN_HUB_PATH, rel),
        path.resolve(__dirname, '../../xchain-hub', rel),                          // bundled into e2e image
        path.resolve(__dirname, '../../../xchain-hub', rel),                       // monorepo dev
        path.resolve(__dirname, '../../../../xchain-hub', rel),                    // xchain-node layout
        path.resolve(__dirname, '../../../../../modules/xchain-hub', rel)          // installed via xchain-node
    ].filter(Boolean);
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    throw new Error(
        'MultiValidatorHub: cannot resolve xchain-hub source. Set XCHAIN_HUB_PATH ' +
        'to the xchain-hub directory or place xchain-hub adjacent to xchain-e2e-test. ' +
        'Tried: ' + candidates.join(', ')
    );
}

function _loadHubModule(rel){
    return require(_resolveHubFile(rel));
}

const XChainHub        = _loadHubModule('src/XChainHub.js');
const ValidatorIdentity = _loadHubModule('src/ValidatorIdentity.js');

// Check whether a TCP port is free. Used for picking unused P2P ports
// at startup so concurrent test runs don't collide.
function _portFree(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '127.0.0.1');
    });
}

async function _pickFreePorts(count, base) {
    const picked = [];
    let p = base;
    while (picked.length < count && p < base + 1000) {
        if (await _portFree(p)) picked.push(p);
        p++;
    }
    if (picked.length < count) throw new Error('MultiValidatorHub: not enough free ports near ' + base);
    return picked;
}

// Promise.race with a tagged-error timeout. The slow path (a hub close
// that gets stuck on a peer drain) gets bounded so the test harness
// can finish teardown deterministically.
function _withTimeout(promise, ms, label){
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout ' + (label || '') + ' after ' + ms + 'ms')), ms))
    ]);
}

class MultiValidatorHub {

    /**
     * @param opts.count                number of hub instances (>= 1, typically 3)
     * @param opts.dbHost / dbPort      MariaDB connection (defaults from env: HUB_DB_HOST/PORT)
     * @param opts.dbUser / dbPass      MariaDB credentials (defaults from env: HUB_DB_USER/PASS)
     * @param opts.dbNamePrefix         per-hub DB name prefix (defaults to 'XChain_BTC_Regtest_MVH_'+pid)
     * @param opts.basePort             starting P2P port to probe (defaults to 28000)
     * @param opts.btcIndexerApiUrl     URL the hubs poll for pending requests
     *                                  (defaults from env: BTC_INDEXER_API_URL → http://INDEXER_URL:INDEXER_API_PORT)
     * @param opts.oracleEpochStart    ORACLE_EPOCH_START required by the hub even when oracle isn't started
     */
    constructor(opts) {
        opts = opts || {};
        this.count         = opts.count || 3;
        this.dbHost        = opts.dbHost || process.env.HUB_DB_HOST || process.env.DATABASE_URL || 'mariadb';
        this.dbPort        = opts.dbPort || process.env.HUB_DB_PORT || process.env.DATABASE_PORT || 3306;
        this.dbUser        = opts.dbUser || process.env.HUB_DB_USER;
        this.dbPass        = opts.dbPass || process.env.HUB_DB_PASS;
        this.dbNamePrefix  = opts.dbNamePrefix || ('XChain_BTC_Regtest_MVH_' + process.pid + '_');
        this.basePort      = opts.basePort || 28000;
        this.btcIndexerApiUrl = opts.btcIndexerApiUrl
            || process.env.BTC_INDEXER_API_URL
            || ('http://' + (process.env.INDEXER_URL || 'localhost') + ':' + (process.env.INDEXER_API_PORT || '12001'));
        this.oracleEpochStart = opts.oracleEpochStart || Date.now() - 60_000;

        // Subsystem toggles. Attestation is the historical default (the harness was
        // built attestation-first); a DEX-federation run flips startCrossChain on and
        // can skip attestation to stay lean. At least one must be on to be useful.
        this.startAttestationSubsystem = opts.startAttestation !== false;
        this.startCrossChainSubsystem  = opts.startCrossChain === true;
        // Per-coin cross-chain indexer URLs the DEX engine polls for the offer book.
        // { LTC: '<url>', DOGE: '<url>', BTC: '<url>' } — wired onto each hub's engine
        // AFTER startCrossChain (the engine reads indexers at construction, so we
        // overwrite the resolved map post-start). Absent ⇒ engine idles (no matching).
        this.crossChainIndexerUrls = opts.crossChainIndexerUrls || null;

        // Pre-supplied validator identities (`[{pubkeyHex, privkeyHex}, ...]`). When given,
        // the harness uses these instead of generating fresh keypairs — required for a live
        // on-chain proof where the hubs' signing keys MUST equal the pubkeys staked on BTC.
        // Length must be >= count (extras ignored).
        this.presetIdentities = opts.identities || null;

        // Full-node tier (NODEPROOF). When `fullnode` is set, each hub receives it as
        // its p2pConfig.FULLNODE block (REWARD_SHARE, GENESIS_VERIFIERS, challenge
        // cadence/depth). `coinRpcUrls[i]` supplies hub i's BTC full-node RPC; a
        // null/absent entry models a LIGHT validator (no coin node → cannot answer the
        // possession challenge). Absent ⇒ the FullNodeChallengeRound stays dormant.
        this.fullnode    = opts.fullnode || null;
        this.coinRpcUrls = opts.coinRpcUrls || null;

        this.hubs         = [];
        this.identities   = [];    // [{pubkeyHex, privkeyHex}]
        this.dbNames      = [];
        this.ports        = [];
    }

    // Stand up `count` hubs. Idempotent — re-calling reuses the existing instances.
    async start(){
        if (this.hubs.length > 0) return;

        if (!this.dbUser || !this.dbPass) {
            throw new Error('MultiValidatorHub: HUB_DB_USER and HUB_DB_PASS must be set');
        }

        if (this.presetIdentities && this.presetIdentities.length < this.count) {
            throw new Error('MultiValidatorHub: identities provided (' + this.presetIdentities.length + ') < count (' + this.count + ')');
        }

        // Generate keypairs (or use pre-supplied ones) + pick ports + name DBs up front so
        // the SEED_NODES list can cross-reference (each hub points at every other's P2P_PORT).
        for (let i = 0; i < this.count; i++) {
            this.identities.push(this.presetIdentities
                ? { pubkeyHex: this.presetIdentities[i].pubkeyHex, privkeyHex: this.presetIdentities[i].privkeyHex }
                : ValidatorIdentity.generate());
            this.dbNames.push(this.dbNamePrefix + i);
        }
        this.ports = await _pickFreePorts(this.count, this.basePort);

        // The hub's _resolveBtcIndexerUrl() reads process.env.BTC_INDEXER_API_URL
        // on every 15s poll (not just at start). Set it for the lifetime of the
        // harness and restore once on stop() — otherwise polls after start()
        // return undefined and the hubs silently never see pending requests.
        this._savedIndexerUrl = process.env.BTC_INDEXER_API_URL;
        process.env.BTC_INDEXER_API_URL = this.btcIndexerApiUrl;

        // Start each hub. Sequential start (rather than Promise.all) so the
        // logs interleave cleanly and DB creation doesn't race.
        for (let i = 0; i < this.count; i++) {
            const port  = this.ports[i];
            const peers = this.ports
                .map((p, j) => j === i ? null : ('127.0.0.1:' + p))
                .filter(Boolean);
            const p2pConfig = {
                P2P_PORT:               port,
                P2P_HOST:               '127.0.0.1',
                SEED_NODES:             peers,
                P2P_VALIDATOR_ADDR:     '127.0.0.1:' + port,
                SIGNING_PRIVKEY_HEX:    this.identities[i].privkeyHex,
                REQUIRE_SIGNATURES:     true,
                P2P_HEARTBEAT_INTERVAL: 15000,
                P2P_RECONNECT_BASE:     2000,
                P2P_RECONNECT_MAX:      60000,
                P2P_MSG_DEDUP_TTL:      60000,
                P2P_MAX_PAYLOAD:        1048576,
                // In-process tests put every validator on 127.0.0.1, so the
                // per-IP inbound cap (PeerManager default 3) throttles the mesh
                // at N>4. Honour an env override so N=10 scale runs can raise it;
                // unset → undefined → PeerManager keeps its production default 3
                // (existing N≤4 suites unaffected).
                P2P_MAX_CONNECTIONS_PER_IP: process.env.P2P_MAX_CONNECTIONS_PER_IP,
                // Names the deployment network for consensus gating + canonical
                // derivation (e.g. NODEPROOF's challenge_id binds NETWORK). MUST
                // match the indexers this hub federates with, or signatures over
                // network-bound canonicals fail to verify.
                HUB_NETWORK:            (process.env.NETWORK || 'regtest'),
                ORACLE_EPOCH_START:     this.oracleEpochStart,
                // Long poll so the engine's auto-discovery timer never races the
                // test's manual _discoverAndMatch() triggers — rounds are driven
                // deterministically, not on a 15s wall clock.
                XDEX_POLL_MS:           600000,
            };

            // Full-node tier: inject the FULLNODE block + this hub's coin RPC (per
            // index). A hub with no coinRpcUrls entry is a light validator.
            if (this.fullnode) {
                p2pConfig.FULLNODE = Object.assign({}, this.fullnode);
                if (this.coinRpcUrls && this.coinRpcUrls[i]) p2pConfig.FULLNODE.BTC_RPC = this.coinRpcUrls[i];
            }

            const hub = new XChainHub(
                this.dbHost, this.dbPort, this.dbNames[i],
                this.dbUser, this.dbPass,
                p2pConfig
            );
            await hub.start();
            await hub.startP2P();
            await hub.startConsensus();
            // startOracle, startReorgHandler, startGovernance intentionally skipped.
            if(this.startCrossChainSubsystem){
                await hub.startCrossChain();
                // The engine resolved its (empty) per-coin indexer map at construction;
                // point it at the offer-book mock now. The byzantine test repoints one
                // hub's map to a divergent book after start().
                if(this.crossChainIndexerUrls){
                    let dex = hub.getCrossChainDex && hub.getCrossChainDex();
                    if(dex && dex.indexers){
                        for(let coin of Object.keys(this.crossChainIndexerUrls)){
                            dex.indexers[coin] = { url: this.crossChainIndexerUrls[coin], key: '' };
                        }
                    }
                }
            }
            if(this.startAttestationSubsystem){
                await hub.startAttestation();
            }
            this.hubs.push(hub);
        }

        // Mutual validator registration. Each hub maintains its own per-hub
        // `validators` table (consulted by PeerManager for sig verification +
        // by Consensus for leader rotation); without registration each hub
        // drops every signed message from its peers with "Invalid signature".
        // Production deployments bootstrap this via the registervalidator
        // JSON-RPC; in-process we call it directly.
        for (let i = 0; i < this.hubs.length; i++) {
            for (let j = 0; j < this.hubs.length; j++) {
                await this.hubs[i].registerValidator(
                    this.identities[j].pubkeyHex,
                    '127.0.0.1:' + this.ports[j]
                );
            }
        }
    }

    // Validator pubkeys (hex), in hub index order.
    getPubkeys(){ return this.identities.map(id => id.pubkeyHex); }

    // CrossChainDexEngine instances, in hub index order (null per hub when the
    // DEX subsystem wasn't started). Used by DEX-federation tests to drive rounds.
    getCrossChainDexes(){ return this.hubs.map(h => (h.getCrossChainDex && h.getCrossChainDex()) || null); }

    // Wire a broadcast hook into each hub's AttestationPublisher. Only the
    // round leader actually invokes it (others no-op per request), so a
    // single shared hook is safe. `fn(wirePayload, event)` should return
    // `{ txid }`.
    setBroadcastHook(fn){
        for (const hub of this.hubs) {
            const publisher = hub.getAttestationPublisher && hub.getAttestationPublisher();
            if (publisher && typeof publisher.setBroadcastHook === 'function') {
                publisher.setBroadcastHook(fn);
            }
        }
    }

    // Wire a broadcast hook into each hub's FullNodeChallengeRound (NODEPROOF
    // verdict publisher). Only the elected leader invokes it per epoch, so a
    // single shared funded publisher address is safe. `fn(wirePayload)` returns
    // `{ txid }`.
    setNodeProofBroadcastHook(fn){
        for (const hub of this.hubs) {
            const eng = hub.getFullNodeChallenge && hub.getFullNodeChallenge();
            if (eng && typeof eng.setBroadcastHook === 'function') eng.setBroadcastHook(fn);
        }
    }

    // Stop all hubs + their timers; close DB connections. Idempotent.
    //
    // The hubs' PeerManager.stop() awaits httpServer.close(), which waits for
    // all WebSocket connections to fully drain. With N cross-connected hubs
    // shutting down in sequence, each one's stop() can block waiting for
    // peers that are themselves waiting — a classic coordinated-shutdown
    // race. Mitigations:
    //   1. Force-close WS connections + destroy the httpServer's sockets
    //      BEFORE calling peerManager.stop(), so close() doesn't wait.
    //   2. Race every step with a per-step timeout — defensive in case
    //      the hub's close path still hangs on something else.
    async stop(){
        for (const hub of this.hubs) {
            try {
                await _withTimeout(this._stopOne(hub), 10000, 'hub.stop');
            } catch (e) {
                console.warn('MultiValidatorHub: stop error:', e);
            }
        }
        this.hubs = [];

        // Restore process.env.BTC_INDEXER_API_URL to whatever the host test
        // process had before start() — keeps the harness hermetic.
        if (this._savedIndexerUrl === undefined) delete process.env.BTC_INDEXER_API_URL;
        else                                      process.env.BTC_INDEXER_API_URL = this._savedIndexerUrl;
        this._savedIndexerUrl = undefined;
    }

    async _stopOne(hub){
        // Stop attestation subsystems first (their poll timers + message
        // handlers reference peerManager; clearing first avoids hits after close).
        // Stop the DEX engine first (its poll/flush timers + the consensus
        // message handler reference peerManager; clear before the WS force-close).
        if (hub.getCrossChainDex && hub.getCrossChainDex() && typeof hub.getCrossChainDex().stop === 'function') await _withTimeout(hub.getCrossChainDex().stop(), 3000, 'crossChainDex.stop');

        if (hub.attestationSpotChecker && typeof hub.attestationSpotChecker.stop === 'function') await _withTimeout(hub.attestationSpotChecker.stop(), 3000, 'attestationSpotChecker.stop');
        if (hub.attestationRound       && typeof hub.attestationRound.stop       === 'function') await _withTimeout(hub.attestationRound.stop(),       3000, 'attestationRound.stop');
        if (hub.attestationConsensus   && typeof hub.attestationConsensus.stop   === 'function') await _withTimeout(hub.attestationConsensus.stop(),   3000, 'attestationConsensus.stop');
        if (hub.attestationPublisher   && typeof hub.attestationPublisher.stop   === 'function') await _withTimeout(hub.attestationPublisher.stop(),   3000, 'attestationPublisher.stop');
        if (hub.getFullNodeChallenge   && hub.getFullNodeChallenge() && typeof hub.getFullNodeChallenge().stop === 'function') await _withTimeout(hub.getFullNodeChallenge().stop(), 3000, 'fullNodeChallenge.stop');

        // Force-close WS server + connections so peerManager.stop() →
        // httpServer.close() doesn't wait for a graceful drain.
        const pm = hub.peerManager;
        if (pm) {
            try {
                for (const [, peer] of pm.peers) {
                    if (peer.reconnectTimer) clearTimeout(peer.reconnectTimer);
                    if (peer.ws) { try { peer.ws.terminate(); } catch {} }
                }
                if (pm.wss) {
                    pm.wss.clients.forEach(ws => { try { ws.terminate(); } catch {} });
                }
                if (pm.httpServer && typeof pm.httpServer.closeAllConnections === 'function') {
                    pm.httpServer.closeAllConnections();
                }
            } catch (e) {
                console.warn('MultiValidatorHub: force-close peers failed:', e);
            }
        }

        await _withTimeout(hub.close(), 5000, 'hub.close');
    }

    // Drop the per-hub MariaDB databases. Call after stop() to clean up
    // a hermetic test run.
    async dropDatabases(){
        const pool = mariadb.createPool({
            host: this.dbHost, port: this.dbPort,
            user: this.dbUser, password: this.dbPass,
            connectionLimit: 1
        });
        try {
            for (const name of this.dbNames) {
                try { await pool.query('DROP DATABASE IF EXISTS `' + name + '`'); }
                catch (e) { console.warn('MultiValidatorHub: drop ' + name + ' failed:', e); }
            }
        } finally {
            try { await pool.end(); } catch {}
        }
    }
}

module.exports = { MultiValidatorHub, ValidatorIdentity, loadHubModule: _loadHubModule, resolveHubFile: _resolveHubFile };
