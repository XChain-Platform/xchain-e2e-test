/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * L5 byzantine / fault-tolerance — config-PBFT under adversarial conditions
 *
 * Boots N=4 in-process XChainHub validators (quorum 3, tolerates f=1) on a
 * disposable DB with a seeded stake snapshot, then injects faults and asserts
 * the two properties that define a correct BFT federation:
 *
 *   LIVENESS — a silent (crashed/partitioned) follower must NOT stall the
 *     federation: the honest majority still reaches quorum and applies.
 *   SAFETY   — a forged proposal (config whose digest doesn't match) must be
 *     rejected by honest validators with no state change.
 *
 * Faults are injected by monkey-patching hub instances (test/helpers/
 * byzantineFaults.js) — no production-code changes. Coverage-matrix gap: PBFT
 * L5 was ⬜. Spec: claude/reports/specs/2026-05-30_validator-test-spec.md §6.
 *
 * Runs on a disposable Docker MariaDB; skips only when neither an env DB nor
 * Docker is available.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub }    = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedStakeSnapshot }    = require('../helpers/seededStakeSnapshot');
const { silenceValidator, forgedPrePrepare } = require('../helpers/byzantineFaults');

const COUNT         = 4;       // quorum 3 → tolerates exactly 1 byzantine/silent fault
const PEER_WAIT_MS  = 8000;
const APPLY_WAIT_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The leader for the next sequence (all hubs agree — same sorted set + seq).
function findLeader(mvh) {
    return mvh.hubs.find((h) => {
        const l = h.consensus._getLeader(h.consensus.seq + 1);
        return l && l.addr === h.consensus.peerManager.validatorAddr;
    });
}

describe('MultiValidatorHub — byzantine fault tolerance (L5)', function () {
    this.timeout(180_000);

    let db, mvh, seed;

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping byzantine L5 — no env DB and Docker unavailable'); this.skip(); }
        mvh = new MultiValidatorHub({ count: COUNT, basePort: 32000 });
        await mvh.start();
        await sleep(PEER_WAIT_MS);
        seed = seedStakeSnapshot(mvh);
    });

    after(async function () {
        if (seed) seed.restore();
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (db)  { await db.stop(); }
    });

    it('LIVENESS: a silent follower does not stall the federation (f=1)', async function () {
        const COIN = 'BTC', NET = 'regtest', MODULE = 'node', VALUE = '777777';
        const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: VALUE } } } };

        const leader = findLeader(mvh);
        assert.ok(leader, 'no leader identified');

        // Crash one NON-leader follower.
        const victim = mvh.hubs.find((h) => h !== leader);
        const restore = silenceValidator(victim);
        try {
            await leader.addParametersFromJson(config);   // needs 3 of 4 → honest majority suffices
            await sleep(APPLY_WAIT_MS);

            const honest = mvh.hubs.filter((h) => h !== victim);
            for (const h of honest) {
                const cfg = await h.db.getConfig(COIN, NET, MODULE);
                assert.strictEqual(cfg.GAS_PRICE, VALUE,
                    'an honest hub failed to apply despite quorum being reachable');
            }
            // The silenced hub legitimately never applied (it processed nothing).
            const victimCfg = await victim.db.getConfig(COIN, NET, MODULE);
            assert.notStrictEqual(victimCfg.GAS_PRICE, VALUE,
                'the silenced validator somehow applied — it should have been inert');
        } finally {
            restore();
        }
    });

    it('SAFETY: a forged-digest PRE_PREPARE is rejected with no state change', async function () {
        const COIN = 'BTC', NET = 'regtest', MODULE = 'node';
        const forgedValue = '666666';
        const target = mvh.hubs[mvh.hubs.length - 1];   // any honest hub
        const seq = 9000;                               // well above any applied seq

        const before = await target.db.getConfig(COIN, NET, MODULE);
        assert.notStrictEqual(before.GAS_PRICE, forgedValue, 'precondition: forged value not already set');

        // Feed the forged proposal straight into the consensus handler.
        await target.consensus._handlePrePrepare(
            forgedPrePrepare(seq, { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: forgedValue } } } }, seed.blockIndex)
        );

        assert.ok(!target.consensus.pendingProposals.has(seq),
            'forged PRE_PREPARE created a pending proposal — digest check failed');

        await sleep(500);
        const after = await target.db.getConfig(COIN, NET, MODULE);
        assert.notStrictEqual(after.GAS_PRICE, forgedValue,
            'forged config was applied — safety violated');
    });

    it('SAFETY: an equivocating leader cannot make a follower adopt two configs for one seq', async function () {
        const COIN = 'BTC', NET = 'regtest', MODULE = 'node';
        const follower = mvh.hubs[1];
        const seq = 8000;   // fresh, above any applied seq
        const configA = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: '111' } } } };
        const configB = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: '222' } } } };
        const digestA = follower.consensus._digest(configA);
        const digestB = follower.consensus._digest(configB);
        const env = (digest, config) => ({
            sender: '127.0.0.1:58000',   // the (byzantine) leader
            data: { seq, configDigest: digest, config, btcBlockHeight: seed.blockIndex }
        });

        // First proposal locks the follower onto config A.
        await follower.consensus._handlePrePrepare(env(digestA, configA));
        assert.ok(follower.consensus.pendingProposals.has(seq), 'first PRE_PREPARE should create a proposal');

        // Equivocation: a second, conflicting PRE_PREPARE for the SAME seq (config B,
        // with its own valid digest). The follower must stay locked to the first
        // config — dedup-by-seq is the safety mechanism, so it cannot adopt both.
        await follower.consensus._handlePrePrepare(env(digestB, configB));

        const prop = follower.consensus.pendingProposals.get(seq);
        assert.strictEqual(prop.digest, digestA,
            'follower switched to the equivocating second config — double-adoption');
        assert.notStrictEqual(prop.digest, digestB);
    });
});
