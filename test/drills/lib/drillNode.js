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
 * ONE validator, one OS process. The unit of the physical multi-box drill.
 *
 * Run directly (`node drillNode.js`), configured entirely by environment, and
 * driven over stdin/stdout with lib/protocol.js. That transport is deliberate:
 * it is identical whether the process was forked locally or opened through an
 * ssh pipe, so the harness has exactly one code path for "local box" and
 * "box across the internet".
 *
 * Credentials are read by THIS process from its own box (DRILL_ENV_FILE), never
 * passed in by the harness, so hub DB passwords never cross the control channel
 * and never land in a drill log.
 *
 * Environment:
 *   DRILL_ID                node label, e.g. v3
 *   DRILL_ENV_FILE          optional KEY=value file sourced for HUB_DB_* creds
 *   DRILL_HUB_PATH          xchain-hub directory on this box
 *   DRILL_P2P_HOST/_PORT    bind address + port
 *   DRILL_SEEDS             comma-separated peer endpoints
 *   DRILL_PRIVKEY_HEX       this validator's Ed25519 seed (32-byte hex)
 *   DRILL_VALIDATOR_PUBKEYS comma-separated pubkeys of the whole federation
 *   DRILL_DB_NAME           this validator's hub DB
 *   DRILL_SNAPSHOT_BLOCK    block index the seeded stake snapshot reports
 *   DRILL_MAX_CONN_PER_IP   P2P per-IP inbound cap
 *   DRILL_FAKE_HUB=1        harness self-test: no hub, no DB, protocol only
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { encode, LineSplitter } = require('./protocol');
const byz = require('./liveByzantineFaults');

function emit(obj) { process.stdout.write(encode(obj)); }

// Load KEY=value pairs from a file on THIS box into process.env. Values are
// never echoed: the drill log records only which keys were found.
function loadEnvFile(file) {
    if (!file || !fs.existsSync(file)) return [];
    const keys = [];
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[key] = value;
        keys.push(key);
    }
    return keys;
}

function resolveHubModule(rel) {
    const roots = [
        process.env.DRILL_HUB_PATH,
        path.resolve(__dirname, '../../../../xchain-hub'),
        path.resolve(__dirname, '../../../xchain-hub')
    ].filter(Boolean);
    for (const r of roots) {
        const p = path.join(r, rel);
        if (fs.existsSync(p)) return require(p);
    }
    throw new Error('drillNode: cannot resolve xchain-hub ' + rel + '; set DRILL_HUB_PATH. Tried: ' + roots.join(', '));
}

const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Fake validator: exercises the harness protocol with no hub, no DB, no
// network. It is NOT a consensus model and never produces a drill verdict; the
// drill refuses to run against it. Its only job is to let the runner, the
// command surface and the teardown path be tested on a laptop.
// ---------------------------------------------------------------------------
function makeFakeNode(id) {
    const applied = {};
    let mode = 'none';
    return {
        pubkey: 'fa'.repeat(16) + id.replace(/\D/g, '').padStart(4, '0'),
        async boot() {},
        async hello() { return { id, fake: true, pubkey: this.pubkey }; },
        async peers() { return { peers: 0 }; },
        async quorum() { return { quorum: null }; },
        async fault(a) { mode = a.mode; return { mode }; },
        async dropDb() { return { dropped: false, reason: 'fake node has no database' }; },
        async propose(a) {
            if (mode === 'silent') return { accepted: false, reason: 'silenced' };
            Object.assign(applied, a.values || {});
            return { accepted: true };
        },
        async getConfig(a) { return { value: (a.key in applied) ? applied[a.key] : null }; },
        async forgePrePrepare() { return { pendingCreated: false }; },
        async stop() {}
    };
}

// ---------------------------------------------------------------------------
// Real validator.
// ---------------------------------------------------------------------------
function makeHubNode(id) {
    let hub = null;
    let identity = null;
    let restoreFault = null;
    let restoreSnapshot = null;
    let restoreCountMode = null;

    // Seed this validator's OWN stake snapshot. In-process the fixture patches
    // every hub from one place; here each process must seed itself, because the
    // harness deliberately holds no reference to a remote hub object.
    function seedSnapshot(h, pubkeys, blockIndex) {
        const validators = pubkeys.map((pubkey) => ({ pubkey, amount: '1000.00000000' }));
        const base = { validators, count: validators.length, blockIndex };
        const fresh = (extra) => Object.assign({}, base, extra, { validators: validators.slice() });
        const cs = h.capabilitySnapshot;
        const origActive = cs.getActiveValidatorSnapshot;
        const origPerCap = cs.getSnapshot;
        const origBlock  = h._resolveBtcLatestBlock;
        cs.getActiveValidatorSnapshot = async () => fresh({ capability: null });
        cs.getSnapshot                = async (capability) => fresh({ capability });
        h._resolveBtcLatestBlock      = async () => blockIndex;
        return () => {
            cs.getActiveValidatorSnapshot = origActive;
            cs.getSnapshot                = origPerCap;
            h._resolveBtcLatestBlock      = origBlock;
        };
    }

    // regtest activates stake-weighted quorum at genesis; the drill seeds only
    // the COUNT snapshot, so lift the activation out of reach for this run (the
    // same runtime-only move forceCountModeQuorum makes in-process).
    function forceCountMode() {
        const swq = resolveHubModule('src/stake_weighted_quorum.js');
        const nets = ['regtest', 'testnet'];
        const saved = {};
        for (const n of nets) { saved[n] = swq.STAKE_WEIGHTED_QUORUM_ACTIVATION[n]; swq.STAKE_WEIGHTED_QUORUM_ACTIVATION[n] = Number.MAX_SAFE_INTEGER; }
        return () => { for (const n of nets) swq.STAKE_WEIGHTED_QUORUM_ACTIVATION[n] = saved[n]; };
    }

    return {
        get pubkey() { return identity ? identity.getPubkeyHex() : null; },

        async boot() {
            const XChainHub         = resolveHubModule('src/XChainHub.js');
            const ValidatorIdentity = resolveHubModule('src/ValidatorIdentity.js');

            const privkeyHex = process.env.DRILL_PRIVKEY_HEX;
            if (!privkeyHex) throw new Error('drillNode: DRILL_PRIVKEY_HEX is required');
            identity = new ValidatorIdentity(privkeyHex);

            const host = process.env.DRILL_P2P_HOST || '127.0.0.1';
            const port = parseInt(process.env.DRILL_P2P_PORT, 10);
            if (!port) throw new Error('drillNode: DRILL_P2P_PORT is required');

            restoreCountMode = forceCountMode();

            const p2pConfig = {
                P2P_PORT:                   port,
                P2P_HOST:                   host,
                SEED_NODES:                 csv(process.env.DRILL_SEEDS),
                P2P_VALIDATOR_ADDR:         host + ':' + port,
                SIGNING_PRIVKEY_HEX:        privkeyHex,
                REQUIRE_SIGNATURES:         true,
                P2P_HEARTBEAT_INTERVAL:     15000,
                P2P_RECONNECT_BASE:         2000,
                P2P_RECONNECT_MAX:          60000,
                P2P_MSG_DEDUP_TTL:          60000,
                P2P_MAX_PAYLOAD:            1048576,
                P2P_MAX_CONNECTIONS_PER_IP: parseInt(process.env.DRILL_MAX_CONN_PER_IP, 10) || 64,
                HUB_NETWORK:                process.env.NETWORK || 'regtest',
                ORACLE_EPOCH_START:         Date.now() - 60000,
                XDEX_POLL_MS:               600000
            };

            const dbUser = process.env.HUB_DB_USER;
            const dbPass = process.env.HUB_DB_PASS;
            if (!dbUser || !dbPass) {
                throw new Error('drillNode: HUB_DB_USER/HUB_DB_PASS not set on this box (point DRILL_ENV_FILE at a credentials file)');
            }

            hub = new XChainHub(
                process.env.HUB_DB_HOST || '127.0.0.1',
                process.env.HUB_DB_PORT || 3306,
                process.env.DRILL_DB_NAME,
                dbUser, dbPass, p2pConfig
            );
            await hub.start();
            await hub.startP2P();
            await hub.startConsensus();

            const pubkeys = csv(process.env.DRILL_VALIDATOR_PUBKEYS);
            const addrs   = csv(process.env.DRILL_VALIDATOR_ADDRS);
            if (pubkeys.length !== addrs.length) {
                throw new Error('drillNode: DRILL_VALIDATOR_PUBKEYS and DRILL_VALIDATOR_ADDRS must be the same length');
            }

            // Register the whole federation in THIS validator's own `validators`
            // table. PeerManager consults it to verify peer signatures and
            // Consensus derives leader rotation from it, so an unregistered mesh
            // connects, agrees on quorum, and then elects nobody. Production
            // bootstraps this over the registervalidator JSON-RPC; a drill box
            // has no operator, so each validator seeds its own copy.
            for (let i = 0; i < pubkeys.length; i++) {
                await hub.registerValidator(pubkeys[i], addrs[i]);
            }

            restoreSnapshot = seedSnapshot(hub, pubkeys, parseInt(process.env.DRILL_SNAPSHOT_BLOCK, 10) || 100);
        },

        async hello() {
            return { id, fake: false, pubkey: identity.getPubkeyHex(), addr: hub.peerManager.validatorAddr };
        },
        async peers() {
            return { peers: hub.peerManager ? hub.peerManager.peers.size : 0 };
        },
        async quorum() {
            const snap = await hub.capabilitySnapshot.getActiveValidatorSnapshot();
            return { quorum: hub.capabilitySnapshot.getQuorum(snap), snapshotCount: snap.count };
        },
        async seq() {
            return { seq: hub.consensus ? hub.consensus.seq : null };
        },
        // Leader rotation is deterministic over the sorted validator set, so
        // every node computes the same answer; the harness asks all of them and
        // expects exactly one yes.
        async isLeader() {
            const c = hub.consensus;
            if (!c) return { leader: false, seq: null };
            const l = c._getLeader(c.seq + 1);
            return { leader: !!(l && l.addr === c.peerManager.validatorAddr), seq: c.seq + 1 };
        },
        async alignSeq(a) {
            if (hub.consensus && Number.isInteger(a.seq) && a.seq > hub.consensus.seq) hub.consensus.seq = a.seq;
            return { seq: hub.consensus ? hub.consensus.seq : null };
        },
        async clearPending() {
            if (hub.consensus && hub.consensus.pendingProposals) hub.consensus.pendingProposals.clear();
            return { cleared: true };
        },

        // Apply a fault to THIS process. 'none' restores.
        async fault(a) {
            if (restoreFault) { restoreFault(); restoreFault = null; }
            if (a.mode === 'silent')      restoreFault = byz.silenceConsensus(hub);
            else if (a.mode === 'forge')  restoreFault = byz.forgeConsensusSignatures(hub);
            else if (a.mode && a.mode !== 'none') throw new Error('drillNode: unknown fault mode ' + a.mode);
            return { mode: a.mode || 'none' };
        },

        // Propose a config change. Resolution needs a COMMIT quorum, which the
        // boundary phase deliberately denies, so this never blocks the control
        // channel: it acks immediately and reports the outcome as an event.
        async propose(a) {
            const p = hub.addParametersFromJson(a.config);
            p.then(() => emit({ ev: 'proposed', id, ok: true }))
             .catch((e) => emit({ ev: 'proposed', id, ok: false, error: String(e && e.message || e) }));
            return { accepted: true };
        },

        async getConfig(a) {
            const cfg = await hub.db.getConfig(a.coin, a.net, a.module);
            return { value: (cfg && a.key in cfg) ? cfg[a.key] : null };
        },

        // Deliver a forged-digest PRE_PREPARE straight into this node's own
        // consensus engine and report whether it took. An honest node must
        // reject it on the digest check.
        async forgePrePrepare(a) {
            const env = byz.forgedPrePrepare(a.seq, a.config, a.blockIndex);
            await hub.consensus._handlePrePrepare(env);
            return { pendingCreated: hub.consensus.pendingProposals.has(a.seq) };
        },

        // Drop this validator's own hub database. A drill that leaves ten
        // XChain_BTC_Regtest_Drill_* schemas behind on a shared venue is a
        // drill nobody is allowed to run twice, so teardown owns this rather
        // than a follow-up chore.
        async dropDb() {
            const name = process.env.DRILL_DB_NAME;
            if (!name) return { dropped: false, reason: 'no DRILL_DB_NAME' };
            if (hub && hub.stop) { try { await hub.stop(); } catch (e) { /* dropping anyway */ } hub = null; }
            const mariadb = require(path.join(process.env.DRILL_HUB_PATH
                || path.resolve(__dirname, '../../../../xchain-hub'), 'node_modules/mariadb'));
            const conn = await mariadb.createConnection({
                host: process.env.HUB_DB_HOST || '127.0.0.1',
                port: parseInt(process.env.HUB_DB_PORT, 10) || 3306,
                user: process.env.HUB_DB_USER,
                password: process.env.HUB_DB_PASS
            });
            try { await conn.query('DROP DATABASE IF EXISTS \`' + name.replace(/`/g, '') + '\`'); }
            finally { await conn.end(); }
            return { dropped: true, database: name };
        },

        async stop() {
            if (restoreFault)     { restoreFault(); restoreFault = null; }
            if (restoreSnapshot)  { restoreSnapshot(); restoreSnapshot = null; }
            if (restoreCountMode) { restoreCountMode(); restoreCountMode = null; }
            if (hub && hub.stop) { try { await hub.stop(); } catch (e) { /* teardown is best-effort */ } }
        }
    };
}

async function main() {
    const id = process.env.DRILL_ID || 'v?';
    const envKeys = loadEnvFile(process.env.DRILL_ENV_FILE);
    const node = (process.env.DRILL_FAKE_HUB === '1') ? makeFakeNode(id) : makeHubNode(id);

    try {
        await node.boot();
    } catch (e) {
        emit({ ev: 'error', id, phase: 'boot', error: String(e && e.message || e) });
        process.exit(3);
        return;
    }
    emit({ ev: 'ready', id, pid: process.pid, pubkey: node.pubkey, envKeys: envKeys });

    const splitter = new LineSplitter();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        for (const line of splitter.push(chunk)) {
            const text = line.trim();
            if (!text) continue;
            let msg;
            try { msg = JSON.parse(text); } catch (e) { continue; }
            handle(msg);
        }
    });
    // A dropped control channel (ssh died, harness crashed) must not leave a
    // validator holding a port and a DB connection on someone else's box.
    process.stdin.on('end', () => { node.stop().finally(() => process.exit(0)); });

    async function handle(msg) {
        const rid = msg.rid;
        if (msg.cmd === 'stop') {
            await node.stop();
            emit({ rid, ok: true, result: { stopped: true } });
            setTimeout(() => process.exit(0), 50);
            return;
        }
        const fn = node[msg.cmd];
        if (typeof fn !== 'function') {
            emit({ rid, ok: false, error: 'unknown command ' + msg.cmd });
            return;
        }
        try {
            emit({ rid, ok: true, result: await fn.call(node, msg.args || {}) });
        } catch (e) {
            emit({ rid, ok: false, error: String(e && e.message || e) });
        }
    }
}

if (require.main === module) {
    main().catch((e) => { emit({ ev: 'error', phase: 'main', error: String(e && e.message || e) }); process.exit(4); });
}

module.exports = { loadEnvFile, resolveHubModule };
