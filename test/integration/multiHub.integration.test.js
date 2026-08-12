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
 * E2E integration smoke: MultiValidatorHub harness
 *
 * Verifies the harness can stand up N=3 in-process XChainHub instances
 * with cross-referenced P2P SEED_NODES and have them peer-connect.
 *
 * This is the scaffold test for Phase B PBFT verification. The full
 * round-trip test (request → PBFT → response → callback) lives in
 * test/actions/multiHubAttestation.test.js once A2 ships.
 *
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub } = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');

const COUNT = 3;
// Allow plenty of time: first hub start triggers DB create + table init
// + migrations; with 3 hubs sequentially that can be ~10s.
const PEER_WAIT_MS = 8000;

describe('MultiValidatorHub harness: bring-up smoke', function () {
    // 3 hubs × (DB init + schema migrations + P2P bind + peer connect) can run
    // ~15s; teardown (hub.close + DB drop) adds more. Generous budget so we're
    // measuring correctness, not racing the timeout.
    this.timeout(180_000);

    let mvh, db;

    // Was gated on HUB_DB_USER/HUB_DB_PASS being set, which nothing in CI sets,
    // so this suite skipped itself on every venue and the live tier reported it
    // as covered regardless. startDisposableHubDb self-provisions a throwaway
    // MariaDB in Docker exactly as the rest of the L2 suites do, so the only
    // remaining skip is a host with no Docker at all.
    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping MultiValidatorHub smoke: no env DB and Docker unavailable'); this.skip(); }
    });

    after(async function () {
        if (mvh) {
            await mvh.stop();
            await mvh.dropDatabases();
        }
        if (db) await db.stop();
    });

    it('starts ' + COUNT + ' hubs with distinct pubkeys + DBs + ports', async function () {
        mvh = new MultiValidatorHub({ count: COUNT });
        await mvh.start();

        assert.strictEqual(mvh.hubs.length, COUNT, 'expected ' + COUNT + ' running hubs');
        assert.strictEqual(new Set(mvh.dbNames).size, COUNT, 'expected ' + COUNT + ' distinct DB names');
        assert.strictEqual(new Set(mvh.ports).size, COUNT, 'expected ' + COUNT + ' distinct ports');

        const pubkeys = mvh.getPubkeys();
        assert.strictEqual(new Set(pubkeys).size, COUNT, 'expected ' + COUNT + ' distinct pubkeys');
        for (const pk of pubkeys) {
            assert.match(pk, /^[0-9a-f]{64}$/, 'pubkey must be 64 hex chars');
        }
    });

    it('hubs peer-connect via SEED_NODES (each sees count-1 peers within ' + PEER_WAIT_MS + 'ms)', async function () {
        // Reconnect loop is on a backoff; allow some settle time.
        await new Promise(r => setTimeout(r, PEER_WAIT_MS));

        const want = COUNT - 1;
        const peerCounts = mvh.hubs.map(h => h.peerManager ? h.peerManager.peers.size : 0);
        const ok = peerCounts.every(c => c >= want);

        if (!ok) {
            console.log('Peer counts (want >=' + want + '):', peerCounts);
            console.log('Hub ports:', mvh.ports);
        }
        assert.ok(ok, 'all hubs should see ' + want + ' peers, got ' + peerCounts.join(','));
    });

    it('each hub has the attestation framework subsystems active', async function () {
        for (let i = 0; i < mvh.hubs.length; i++) {
            const hub = mvh.hubs[i];
            assert.ok(hub.providerRegistry,     'hub ' + i + ' must have providerRegistry');
            assert.ok(hub.attestationRound,     'hub ' + i + ' must have attestationRound');
            assert.ok(hub.attestationConsensus, 'hub ' + i + ' must have attestationConsensus');
            assert.ok(hub.attestationPublisher, 'hub ' + i + ' must have attestationPublisher');
            assert.ok(hub.identity,             'hub ' + i + ' must have ValidatorIdentity loaded');
        }
    });
});
