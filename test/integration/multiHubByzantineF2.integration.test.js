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
 * Track C.2: byzantine fault tolerance at f>1 (config-PBFT, N=7).
 *
 * The N=4 byzantine suite (multiHubByzantine) proves the BFT floor: quorum 3,
 * f=1. This suite raises the fault budget to f=2 by booting N=7 validators
 * (quorum 2·⌊6/3⌋+1 = 5, tolerating exactly 2 faults) and asserting the three
 * properties that define a correct BFT federation at scale:
 *
 *   LIVENESS (f=2): TWO silent (crashed/partitioned) followers must NOT stall
 *     the federation: the 5 honest validators still reach quorum 5 and apply.
 *   LIVENESS BOUNDARY (f+1=3): a THIRD silent follower pushes the live set to 4,
 *     below quorum 5, so the change must NOT apply anywhere. This pins f=2 as the
 *     EXACT tolerance, not an under-count.
 *   SAFETY: a forged proposal (digest mismatch) and an equivocating leader (two
 *     configs for one seq) are both rejected by honest validators with no state
 *     change, regardless of fault budget.
 *
 * Faults are injected by monkey-patching hub instances (test/helpers/
 * byzantineFaults.js) with no production-code changes. Fills the validator-scale
 * matrix row "Byzantine fault (up to f malicious)". Modeled on
 * multiHubByzantine.integration.test.js (the green N=4 f=1 version) and
 * multiHubConsensusN10.integration.test.js (the N>4 mesh-scaling knobs).
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

const COUNT         = 7;       // quorum 2·⌊6/3⌋+1 = 5 → tolerates exactly f=2
const QUORUM        = 5;
const PEER_WAIT_MS  = 12000;   // 7-node mesh (21 connections) needs time to form
const APPLY_WAIT_MS = 6000;    // COMMIT propagation across 7 hubs
const STALL_WAIT_MS = 6000;    // long enough that a reachable quorum WOULD have applied

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The leader for the next sequence (all hubs agree on the same sorted set + seq).
function findLeader(mvh) {
    return mvh.hubs.find((h) => {
        const l = h.consensus._getLeader(h.consensus.seq + 1);
        return l && l.addr === h.consensus.peerManager.validatorAddr;
    });
}

// Drop any pending (un-committed) proposals across every hub. The no-apply
// boundary round leaves a pending proposal at the next seq on the live hubs;
// since a failed round never advances consensus.seq, the following apply round
// would reuse that same seq and be dropped by dedup-by-seq. Clearing first lets
// the reused seq carry a fresh proposal to COMMIT. (consensus.seq is untouched,
// so the leader rotation and quorum are unchanged.)
function clearPendingProposals(mvh) {
    for (const h of mvh.hubs) {
        if (h.consensus && h.consensus.pendingProposals) h.consensus.pendingProposals.clear();
    }
}

// Re-align every hub's consensus.seq to the max across the federation. A leader
// advances its own seq the moment it PROPOSES, even on a round that never
// commits (a silenced-majority round), so seqs diverge by one after each
// addParametersFromJson. In production a lagging hub catches up via state sync;
// in-process there is none, so we level them up (never down) before the next
// round. This keeps leader rotation unambiguous so findLeader resolves; the
// quorum math (count of honest signers) is unaffected.
function alignSeqs(mvh) {
    let maxSeq = 0;
    for (const h of mvh.hubs) if (h.consensus && h.consensus.seq > maxSeq) maxSeq = h.consensus.seq;
    for (const h of mvh.hubs) if (h.consensus) h.consensus.seq = maxSeq;
}

describe('MultiValidatorHub: byzantine fault tolerance at f=2 (N=7, C.2)', function () {
    this.timeout(300_000);

    let db, mvh, seed;

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping byzantine f=2: no env DB and Docker unavailable'); this.skip(); }
        // All 7 validators share 127.0.0.1 in-process; raise the per-IP inbound
        // cap (PeerManager default 3) so the full 6-peer mesh forms without
        // connection-limit rejections. (Production validators have distinct IPs.)
        process.env.P2P_MAX_CONNECTIONS_PER_IP = '50';
        // basePort below the Linux ephemeral range (32768+) so the picked ports
        // don't race transient outbound sockets between probe and listen.
        mvh = new MultiValidatorHub({ count: COUNT, basePort: 31000 });
        await mvh.start();
        await sleep(PEER_WAIT_MS);
        seed = seedStakeSnapshot(mvh);
    });

    after(async function () {
        if (seed) seed.restore();
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (db)  { await db.stop(); }
    });

    it('all 7 hubs peer-connect (each sees 6) and every hub resolves quorum 5 (f=2)', function () {
        const quorums = [];
        for (const h of mvh.hubs) {
            assert.ok(h.consensus, 'consensus engine not started');
            const peers = h.peerManager ? h.peerManager.peers.size : 0;
            assert.strictEqual(peers, COUNT - 1, 'expected ' + (COUNT - 1) + ' peers, got ' + peers);
            quorums.push(h.consensus.hub.capabilitySnapshot.getQuorum(seed.snapshot));
        }
        assert.ok(quorums.every((q) => q === quorums[0]), 'hubs disagree on quorum: ' + JSON.stringify(quorums));
        assert.strictEqual(quorums[0], QUORUM, 'expected quorum ' + QUORUM + ' for N=7, got ' + quorums[0]);
    });

    // Runs FIRST (on a pristine, seq-aligned federation) so the zero-slack quorum
    // round (exactly 5 honest, all must COMMIT) has a clean mesh with no carry-over
    // pending state from a prior round.
    it('LIVENESS (f=2): TWO silent followers do not stall the federation', async function () {
        const COIN = 'BTC', NET = 'regtest', MODULE = 'node', VALUE = '720001';
        const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: VALUE } } } };

        const leader = findLeader(mvh);
        assert.ok(leader, 'no leader identified');

        // Crash two NON-leader followers (f=2). 5 honest remain = exactly quorum.
        const victims = mvh.hubs.filter((h) => h !== leader).slice(0, 2);
        const restores = victims.map((v) => silenceValidator(v));
        try {
            await leader.addParametersFromJson(config);   // needs 5 of 7 → 5 honest suffice
            await sleep(APPLY_WAIT_MS);

            const honest = mvh.hubs.filter((h) => !victims.includes(h));
            assert.strictEqual(honest.length, QUORUM, 'expected ' + QUORUM + ' honest hubs');
            for (const h of honest) {
                const cfg = await h.db.getConfig(COIN, NET, MODULE);
                assert.strictEqual(cfg.GAS_PRICE, VALUE,
                    'an honest hub failed to apply despite quorum (5 of 7) being reachable');
            }
            for (const v of victims) {
                const cfg = await v.db.getConfig(COIN, NET, MODULE);
                assert.notStrictEqual(cfg.GAS_PRICE, VALUE,
                    'a silenced validator somehow applied; it should have been inert');
            }
        } finally {
            restores.forEach((r) => r());
        }
    });

    it('LIVENESS BOUNDARY (f+1=3): a THIRD silent follower drops below quorum, so nothing applies', async function () {
        const COIN = 'BTC', NET = 'regtest', MODULE = 'node', VALUE = '730001';
        const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: VALUE } } } };

        // The prior apply round advanced the leader's seq (a proposer bumps its own
        // seq even before COMMIT), so re-level all hubs to the max and clear stale
        // pendings. This round is EXPECTED to stall (no quorum), so it tolerates the
        // levelling; what we assert is the absence of any apply.
        alignSeqs(mvh);
        clearPendingProposals(mvh);
        const leader = findLeader(mvh);
        assert.ok(leader, 'no leader identified');

        // Crash THREE non-leader followers (f+1). Only 4 live (leader + 3) < quorum 5.
        const victims = mvh.hubs.filter((h) => h !== leader).slice(0, 3);
        const restores = victims.map((v) => silenceValidator(v));
        try {
            // Quorum is unreachable, so addParametersFromJson never resolves on a
            // COMMIT quorum. Bound the wait and assert the change applied NOWHERE.
            await Promise.race([
                leader.addParametersFromJson(config).catch(() => {}),
                sleep(STALL_WAIT_MS)
            ]);
            await sleep(1000);

            for (let i = 0; i < mvh.hubs.length; i++) {
                const cfg = await mvh.hubs[i].db.getConfig(COIN, NET, MODULE);
                assert.notStrictEqual(cfg.GAS_PRICE, VALUE,
                    'hub ' + i + ' applied a change that lacked quorum (only 4 of 7 live, need 5)');
            }
        } finally {
            restores.forEach((r) => r());
            clearPendingProposals(mvh);
        }
    });

    it('SAFETY: a forged-digest PRE_PREPARE is rejected with no state change', async function () {
        const COIN = 'BTC', NET = 'regtest', MODULE = 'node';
        const forgedValue = '760666';
        const target = mvh.hubs[mvh.hubs.length - 1];   // any honest hub
        const seq = 9100;                               // well above any applied seq

        const before = await target.db.getConfig(COIN, NET, MODULE);
        assert.notStrictEqual(before.GAS_PRICE, forgedValue, 'precondition: forged value not already set');

        await target.consensus._handlePrePrepare(
            forgedPrePrepare(seq, { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: forgedValue } } } }, seed.blockIndex)
        );

        assert.ok(!target.consensus.pendingProposals.has(seq),
            'forged PRE_PREPARE created a pending proposal (digest check failed)');

        await sleep(500);
        const after = await target.db.getConfig(COIN, NET, MODULE);
        assert.notStrictEqual(after.GAS_PRICE, forgedValue, 'forged config was applied (safety violated)');
    });

    it('SAFETY: an equivocating leader cannot make a follower adopt two configs for one seq', async function () {
        const COIN = 'BTC', NET = 'regtest', MODULE = 'node';
        const follower = mvh.hubs[1];
        const seq = 8100;   // fresh, above any applied seq
        const view = 0;
        const configA = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: '7111' } } } };
        const configB = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: '7222' } } } };
        const digestA = follower.consensus._digest(configA);
        const digestB = follower.consensus._digest(configB);
        // A PRE_PREPARE is only accepted from the rotation-designated leader for
        // (seq, view) with a registered sender. An equivocating leader is still the
        // LEGITIMATE leader; it just emits two conflicting configs for one seq.
        const N = follower.consensus.validatorSet.length;
        const leaderAddr = follower.consensus.validatorSet[(seq + view) % N].addr;
        const env = (digest, config) => ({
            sender: leaderAddr,
            data: { seq, view, configDigest: digest, config, btcBlockHeight: seed.blockIndex }
        });

        await follower.consensus._handlePrePrepare(env(digestA, configA));
        assert.ok(follower.consensus.pendingProposals.has(seq), 'first PRE_PREPARE should create a proposal');

        // Equivocation: a second conflicting PRE_PREPARE for the SAME seq. Dedup-by-seq
        // is the safety mechanism; the follower must stay locked to the first config.
        await follower.consensus._handlePrePrepare(env(digestB, configB));

        const prop = follower.consensus.pendingProposals.get(seq);
        assert.strictEqual(prop.digest, digestA, 'follower switched to the equivocating second config');
        assert.notStrictEqual(prop.digest, digestB);
    });
});
