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
 * Track C.2 — N=10 validator-scale probe (config-change PBFT)
 *
 * The federation-sensitive engines are already proven at N=4 (the BFT floor:
 * quorum 3, f=1). Both quorum predicates — count 2f+1 and stake-weighted
 * 3·tally > 2·S — are N-agnostic, so larger N is a throughput/timeout concern,
 * not a correctness one. This test validates that the harness + the simplest
 * consensus engine (config PBFT) hold at N=10:
 *   - a 10-node full P2P mesh forms (each hub sees 9 peers; 45 connections);
 *   - every hub independently resolves the SAME quorum (7 = 2·⌊9/3⌋+1, f=3);
 *   - a leader-proposed config change reaches COMMIT quorum and applies on ALL
 *     10 hubs — proving _pickFreePorts(10), the mesh, seedStakeSnapshot, and the
 *     settle-wait all scale.
 *
 * One engine is enough to validate the scaling knobs; running every engine at
 * N=10 adds wall-clock without new signal (the quorum math is N-agnostic).
 * Modeled on multiHubConsensus.integration.test.js (the green N=4 version).
 *
 * Runs on a disposable Docker MariaDB — skips cleanly when neither an
 * env-provisioned DB nor Docker is available.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub }   = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedStakeSnapshot }    = require('../helpers/seededStakeSnapshot');

// N=10 → quorum 2·⌊9/3⌋+1 = 7, tolerating f=3 faults.
const COUNT         = 10;
const PEER_WAIT_MS  = 12000;  // 45-connection mesh needs more time to fully form
const APPLY_WAIT_MS = 8000;   // COMMIT propagation across 10 hubs

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('MultiValidatorHub — N=10 config-change PBFT scale probe (C.2)', function () {
    this.timeout(300_000);

    let db, mvh, seed;

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) {
            console.log('Skipping N=10 scale probe — no env DB and Docker unavailable');
            this.skip();
        }
        // All 10 validators share 127.0.0.1 in-process; raise the per-IP inbound
        // cap (PeerManager default 3) so the full 9-peer mesh forms without
        // connection-limit rejections. (Production validators have distinct IPs.)
        process.env.P2P_MAX_CONNECTIONS_PER_IP = '50';
        // basePort below the Linux ephemeral range (32768+) so the 10 picked
        // ports don't race transient outbound sockets between probe and listen.
        mvh = new MultiValidatorHub({ count: COUNT, basePort: 26000 });
        await mvh.start();
        await sleep(PEER_WAIT_MS);   // 10-node mesh forms before we propose
        seed = seedStakeSnapshot(mvh);
    });

    after(async function () {
        if (seed) seed.restore();
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (db)  { await db.stop(); }
    });

    it('all 10 hubs peer-connect (each sees 9 peers) and consensus is active', function () {
        for (const h of mvh.hubs) {
            assert.ok(h.consensus, 'consensus engine not started');
            const peers = h.peerManager ? h.peerManager.peers.size : 0;
            assert.strictEqual(peers, COUNT - 1, 'expected ' + (COUNT - 1) + ' peers, got ' + peers);
        }
    });

    it('every hub independently resolves the SAME quorum (7 for N=10) — determinism at scale', function () {
        const quorums = mvh.hubs.map((h) => h.consensus.hub.capabilitySnapshot.getQuorum(seed.snapshot));
        assert.ok(quorums.every((q) => q === quorums[0]),
            'hubs disagree on quorum N: ' + JSON.stringify(quorums));
        assert.strictEqual(quorums[0], 7, 'expected quorum 7 for N=10, got ' + quorums[0]);
    });

    it('a leader-proposed config change reaches quorum and applies on EVERY one of the 10 hubs', async function () {
        const COIN = 'BTC', NET = 'regtest', MODULE = 'node', VALUE = '101010';
        const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: VALUE } } } };

        const leader = mvh.hubs.find((h) => {
            const l = h.consensus._getLeader(h.consensus.seq + 1);
            return l && l.addr === h.consensus.peerManager.validatorAddr;
        });
        assert.ok(leader, 'no round leader could be identified');

        await leader.addParametersFromJson(config);   // resolves on COMMIT quorum (7 of 10)
        await sleep(APPLY_WAIT_MS);                    // let all followers apply

        for (let i = 0; i < mvh.hubs.length; i++) {
            const cfg = await mvh.hubs[i].db.getConfig(COIN, NET, MODULE);
            assert.strictEqual(cfg.GAS_PRICE, VALUE,
                'hub ' + i + ' did not apply the PBFT config change (got ' + JSON.stringify(cfg) + ')');
        }
    });
});
