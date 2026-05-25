/*********************************************************************
 * E2E test helper — Multi-Validator Hub Harness
 *
 * Spins up N XChainHub instances in-process, each with its own:
 *   - MariaDB hub DB (auto-bootstrapped via hub.start())
 *   - Ed25519 signing keypair
 *   - P2P_PORT + cross-referenced SEED_NODES
 *
 * Used to drive real PBFT consensus across multiple validators in tests:
 *   ATTEST_PROPOSE → ATTEST_PREPARE → ATTEST_COMMIT → on-chain
 *   ATTESTATION_RESPONSE published by the leader → indexer callback.
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

// Locate the xchain-hub package. The e2e test repo doesn't list it as an
// npm dep; it lives adjacent in the monorepo or under xchain-node's
// modules/. Try a few well-known locations or accept an explicit override.
function _loadHubModule(rel){
    const candidates = [
        process.env.XCHAIN_HUB_PATH && path.join(process.env.XCHAIN_HUB_PATH, rel),
        path.resolve(__dirname, '../../../xchain-hub', rel),                       // monorepo dev
        path.resolve(__dirname, '../../../../xchain-hub', rel),                    // xchain-node layout
        path.resolve(__dirname, '../../../../../modules/xchain-hub', rel)          // installed via xchain-node
    ].filter(Boolean);
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return require(p);
        } catch (_) { /* try next */ }
    }
    throw new Error(
        'MultiValidatorHub: cannot resolve xchain-hub source. Set XCHAIN_HUB_PATH ' +
        'to the xchain-hub directory or place xchain-hub adjacent to xchain-e2e-test. ' +
        'Tried: ' + candidates.join(', ')
    );
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

class MultiValidatorHub {

    /**
     * @param opts.count                number of hub instances (>= 1, typically 3)
     * @param opts.dbHost / dbPort      MariaDB connection (defaults from env: HUB_DB_HOST/PORT)
     * @param opts.dbUser / dbPass      MariaDB credentials (defaults from env: HUB_DB_USER/PASS)
     * @param opts.dbNamePrefix         per-hub DB name prefix (defaults to 'XChain_BTC_Regtest_MVH_'+pid)
     * @param opts.basePort             starting P2P port to probe (defaults to 28000)
     * @param opts.btcIndexerApiUrl     URL the hubs poll for pending requests
     *                                  (defaults from env: BTC_INDEXER_API_URL → http://INDEXER_HOST:INDEXER_API_PORT)
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
            || ('http://' + (process.env.INDEXER_HOST || 'localhost') + ':' + (process.env.INDEXER_API_PORT || '12001'));
        this.oracleEpochStart = opts.oracleEpochStart || Date.now() - 60_000;

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

        // Generate keypairs + pick ports + name DBs up front so the SEED_NODES
        // list can cross-reference (each hub points at every other's P2P_PORT).
        for (let i = 0; i < this.count; i++) {
            this.identities.push(ValidatorIdentity.generate());
            this.dbNames.push(this.dbNamePrefix + i);
        }
        this.ports = await _pickFreePorts(this.count, this.basePort);

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
                ORACLE_EPOCH_START:     this.oracleEpochStart,
                // BTC_INDEXER_API_URL is read from process.env by the hub;
                // we set it once here for all hubs (they share the same indexer).
            };

            // The hub's BTC indexer lookup falls back to process.env.BTC_INDEXER_API_URL
            // when not in p2pConfig or hub configs table. Set it for the duration of start().
            const savedIndexerUrl = process.env.BTC_INDEXER_API_URL;
            process.env.BTC_INDEXER_API_URL = this.btcIndexerApiUrl;

            try {
                const hub = new XChainHub(
                    this.dbHost, this.dbPort, this.dbNames[i],
                    this.dbUser, this.dbPass,
                    p2pConfig
                );
                await hub.start();
                await hub.startP2P();
                await hub.startConsensus();
                // startOracle, startCrossChain, startReorgHandler, startGovernance
                // intentionally skipped — the harness is attestation-focused.
                await hub.startAttestation();
                this.hubs.push(hub);
            } finally {
                if (savedIndexerUrl === undefined) delete process.env.BTC_INDEXER_API_URL;
                else                                process.env.BTC_INDEXER_API_URL = savedIndexerUrl;
            }
        }
    }

    // Validator pubkeys (hex), in hub index order.
    getPubkeys(){ return this.identities.map(id => id.pubkeyHex); }

    // Stop all hubs + their timers; close DB connections. Idempotent.
    async stop(){
        for (const hub of this.hubs) {
            try {
                if (hub.attestationRound     && hub.attestationRound._pollTimer) clearInterval(hub.attestationRound._pollTimer);
                if (hub.attestationConsensus && typeof hub.attestationConsensus.stop === 'function') await hub.attestationConsensus.stop();
                if (hub.attestationPublisher && typeof hub.attestationPublisher.stop === 'function') await hub.attestationPublisher.stop();
                await hub.close();
            } catch (e) {
                console.warn('MultiValidatorHub: stop error: ' + (e && e.message ? e.message : e));
            }
        }
        this.hubs = [];
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
                catch (e) { console.warn('MultiValidatorHub: drop ' + name + ' failed: ' + (e && e.message ? e.message : e)); }
            }
        } finally {
            try { await pool.end(); } catch {}
        }
    }
}

module.exports = { MultiValidatorHub };
