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
 * L2 integration: config-change PBFT across a multi-validator hub set
 *
 * Boots N=3 in-process XChainHub validators (MultiValidatorHub) and drives the
 * REAL config-consensus path (Consensus.propose → PRE_PREPARE/PREPARE/COMMIT →
 * _applyConfig) end to end over live P2P. Asserts:
 *   - a config change proposed by the round leader reaches COMMIT quorum and is
 *     applied on EVERY hub (not just the proposer), i.e. PBFT actually carries
 *     the change across the federation, persisted to each hub's own DB;
 *   - every hub independently resolves the SAME quorum N for the round
 *     (determinism: the validator-specific bar; divergent N silently splits
 *     the federation).
 *
 * Coverage-matrix gap this closes: PBFT(config) was L1-mocked only (REG-CON-*);
 * L2/L4 were ⬜. Spec: claude/reports/specs/2026-05-30_validator-test-spec.md §6.
 *
 * Runs on a disposable Docker MariaDB (no platform-DB grant needed). Skips
 * cleanly only when neither an env-provisioned DB nor Docker is available.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub }   = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedStakeSnapshot }    = require('../helpers/seededStakeSnapshot');
const { forceCountModeQuorum } = require('../helpers/forceCountModeQuorum');

// 4 validators → quorum 2·⌊3/3⌋+1 = 3 (a real BFT quorum tolerating 1 fault).
// 3 would give quorum 1 (degenerate single-node), which can't prove propagation.
const COUNT        = 4;
const PEER_WAIT_MS = 8000;
const APPLY_WAIT_MS = 3000;   // let COMMIT propagate + followers _applyConfig

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('MultiValidatorHub: config-change PBFT (L2)', function () {
    this.timeout(180_000);

    let db, mvh, seed, countMode;

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) {
            console.log('Skipping config-PBFT L2: no env DB and Docker unavailable');
            this.skip();
        }
        // This suite seeds the COUNT snapshot only, so it must run under legacy
        // count quorum; regtest activates stake-weighted quorum at genesis, which
        // would stall a count-only round at a 1-sig leader self-sign.
        countMode = forceCountModeQuorum();
        mvh = new MultiValidatorHub({ count: COUNT, basePort: 31000 });
        await mvh.start();
        await sleep(PEER_WAIT_MS);   // mesh forms before we propose
        // Seed a deterministic stake snapshot so the federation resolves a real
        // quorum without an indexer (otherwise quorum collapses to a single node).
        seed = seedStakeSnapshot(mvh);
    });

    after(async function () {
        if (seed) seed.restore();
        if (countMode) countMode.restore();
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (db)  { await db.stop(); }
    });

    it('hubs are peer-connected and consensus is active', function () {
        for (const h of mvh.hubs) {
            assert.ok(h.consensus, 'consensus engine not started');
            const peers = h.peerManager ? h.peerManager.peers.size : 0;
            assert.strictEqual(peers, COUNT - 1, 'expected ' + (COUNT - 1) + ' peers, got ' + peers);
        }
    });

    it('every hub independently resolves the SAME, fault-tolerant quorum N (determinism)', function () {
        // The validator-specific bar: divergent quorum N silently splits the
        // federation. Every hub, computing independently from the seeded
        // snapshot, must agree, and the value must be a real BFT majority.
        const quorums = mvh.hubs.map((h) => h.consensus.hub.capabilitySnapshot.getQuorum(seed.snapshot));
        assert.ok(quorums.every((q) => q === quorums[0]),
            'hubs disagree on quorum N: ' + JSON.stringify(quorums));
        assert.strictEqual(quorums[0], 3, 'expected quorum 3 for N=4, got ' + quorums[0]);
    });

    it('a leader-proposed config change reaches quorum and applies on EVERY hub', async function () {
        // Real path: addParametersFromJson → Consensus.propose → PBFT round →
        // _applyConfig on each hub that observes COMMIT quorum.
        const COIN = 'BTC', NET = 'regtest', MODULE = 'node', VALUE = '424242';
        const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: VALUE } } } };

        // All hubs share the same sorted validator set + seq, so exactly one is
        // the leader for the next sequence.
        const leader = mvh.hubs.find((h) => {
            const l = h.consensus._getLeader(h.consensus.seq + 1);
            return l && l.addr === h.consensus.peerManager.validatorAddr;
        });
        assert.ok(leader, 'no round leader could be identified');

        await leader.addParametersFromJson(config);   // resolves on COMMIT quorum
        await sleep(APPLY_WAIT_MS);                    // let followers apply too

        // The change must be persisted on EVERY hub's own DB. This is proof PBFT
        // carried it across the federation, not just the proposer.
        for (let i = 0; i < mvh.hubs.length; i++) {
            const cfg = await mvh.hubs[i].db.getConfig(COIN, NET, MODULE);
            assert.strictEqual(cfg.GAS_PRICE, VALUE,
                'hub ' + i + ' did not apply the PBFT config change (got ' + JSON.stringify(cfg) + ')');
        }
    });

    it('a non-leader proposing is rejected (only the round leader drives)', async function () {
        const nonLeader = mvh.hubs.find((h) => {
            const l = h.consensus._getLeader(h.consensus.seq + 1);
            return l && l.addr !== h.consensus.peerManager.validatorAddr;
        });
        assert.ok(nonLeader, 'expected at least one non-leader');
        await assert.rejects(
            () => nonLeader.consensus.propose({ BTC: { regtest: { node: { GAS_PRICE: '999' } } } }),
            /Not the leader/,
            'a non-leader was allowed to propose'
        );
    });
});
