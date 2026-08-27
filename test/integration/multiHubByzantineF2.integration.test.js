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
 * Track C.2: byzantine fault tolerance at f>1 (config-PBFT).
 *
 * The N=4 byzantine suite (multiHubByzantine) proves the BFT floor: quorum 3,
 * f=1. This suite raises the fault budget past one fault at two scales, and at
 * EACH it asserts the three properties that define a correct BFT federation:
 *
 *   - N=7  (quorum 2·⌊6/3⌋+1 = 5, tolerates exactly f=2)
 *   - N=10 (quorum 2·⌊9/3⌋+1 = 7, tolerates exactly f=3) -> fills the N=10
 *           "Byzantine fault (up to f malicious)" matrix cell at its TRUE tolerance.
 *
 *   LIVENESS (f faults): f silent (crashed/partitioned) followers must NOT stall
 *     the federation: the remaining (quorum-many) honest validators still reach
 *     quorum and apply. This is the zero-slack case (exactly `quorum` honest).
 *   LIVENESS BOUNDARY (f+1 faults): one more silent follower drops the live set
 *     below quorum, so the change must NOT apply anywhere. Pins f as the EXACT
 *     tolerance, not an under-count.
 *   SAFETY: a forged proposal (digest mismatch) and an equivocating leader (two
 *     configs for one seq) are both rejected by honest validators with no state
 *     change, regardless of fault budget.
 *
 * Faults are injected by monkey-patching hub instances (test/helpers/
 * byzantineFaults.js) with no production-code changes. Modeled on
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
const { forceCountModeQuorum } = require('../helpers/forceCountModeQuorum');
const { silenceValidator, forgedPrePrepare } = require('../helpers/byzantineFaults');
const { waitForMesh, waitForConfigEverywhere } = require('../helpers/consensusWait');

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
// the reused seq carry a fresh proposal to COMMIT. (consensus.seq is untouched.)
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

function byzantineScaleSuite({ count, quorum, faults, basePort, peerWaitMs }) {
    // A deadline, not a settle: the honest hubs' own config rows are observable, so
    // the apply wait polls them and returns on the first passing poll.
    const APPLY_WAIT_MS = 60_000;
    // Non-occurrence has no event to wait for, so the boundary round's window stays
    // a fixed observation window.
    const STALL_WAIT_MS = 8000;

    describe('MultiValidatorHub: byzantine fault tolerance at f=' + faults + ' (N=' + count + ', C.2)', function () {
        this.timeout(360_000);

        let db, mvh, seed, countMode;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping byzantine N=' + count + ': no env DB and Docker unavailable'); this.skip(); }
            // Count-only snapshot: pin legacy count quorum (regtest is weighted at
            // genesis, which would stall a count-only round at a 1-sig self-sign).
            countMode = forceCountModeQuorum();
            // All hubs share 127.0.0.1 in-process; raise the per-IP inbound cap
            // (PeerManager default 3) so the full mesh forms. (Prod validators have
            // distinct IPs.)
            process.env.P2P_MAX_CONNECTIONS_PER_IP = '50';
            mvh = new MultiValidatorHub({ count, basePort });
            await mvh.start();
            // peerWaitMs was the mesh settle; as a deadline it is raised to the same
            // 60s bound the other hub suites use (the poll returns as soon as every
            // socket is open, so the bound only decides when to give up).
            await waitForMesh(mvh, { timeoutMs: Math.max(peerWaitMs, 60_000) });
            seed = seedStakeSnapshot(mvh);
        });

        after(async function () {
            if (seed) seed.restore();
            if (countMode) countMode.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('all ' + count + ' hubs peer-connect (each sees ' + (count - 1) + ') and every hub resolves quorum ' + quorum, function () {
            const quorums = [];
            for (const h of mvh.hubs) {
                assert.ok(h.consensus, 'consensus engine not started');
                const peers = h.peerManager ? h.peerManager.peers.size : 0;
                assert.strictEqual(peers, count - 1, 'expected ' + (count - 1) + ' peers, got ' + peers);
                quorums.push(h.consensus.hub.capabilitySnapshot.getQuorum(seed.snapshot));
            }
            assert.ok(quorums.every((q) => q === quorums[0]), 'hubs disagree on quorum: ' + JSON.stringify(quorums));
            assert.strictEqual(quorums[0], quorum, 'expected quorum ' + quorum + ' for N=' + count + ', got ' + quorums[0]);
        });

        // Runs FIRST (on a pristine, seq-aligned federation) so the zero-slack
        // quorum round (exactly `quorum` honest, all must COMMIT) has a clean mesh
        // with no carry-over pending state from a prior round.
        it('LIVENESS (f=' + faults + '): ' + faults + ' silent followers do not stall the federation', async function () {
            const COIN = 'BTC', NET = 'regtest', MODULE = 'node', VALUE = String(count) + '20001';
            const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: VALUE } } } };

            const leader = findLeader(mvh);
            assert.ok(leader, 'no leader identified');

            const victims = mvh.hubs.filter((h) => h !== leader).slice(0, faults);
            const restores = victims.map((v) => silenceValidator(v));
            const honest = mvh.hubs.filter((h) => !victims.includes(h));
            try {
                await leader.addParametersFromJson(config);   // needs `quorum` of `count`
                // The honest hubs' own config rows are the post-condition. Waiting on
                // them also puts the silenced-hub check below strictly AFTER the change
                // propagated, which is the only moment "it stayed inert" proves anything.
                await waitForConfigEverywhere(
                    honest,
                    { coin: COIN, network: NET, module: MODULE, key: 'GAS_PRICE', value: VALUE },
                    { timeoutMs: APPLY_WAIT_MS });

                assert.strictEqual(honest.length, quorum, 'expected ' + quorum + ' honest hubs');
                for (const h of honest) {
                    const cfg = await h.db.getConfig(COIN, NET, MODULE);
                    assert.strictEqual(cfg.GAS_PRICE, VALUE,
                        'an honest hub failed to apply despite quorum (' + quorum + ' of ' + count + ') being reachable');
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

        it('LIVENESS BOUNDARY (f+1=' + (faults + 1) + '): one more silent follower drops below quorum, so nothing applies', async function () {
            const COIN = 'BTC', NET = 'regtest', MODULE = 'node', VALUE = String(count) + '30001';
            const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: VALUE } } } };

            // The prior apply round advanced the leader's seq (a proposer bumps its
            // own seq even before COMMIT), so re-level all hubs to the max and clear
            // stale pendings. This round is EXPECTED to stall (no quorum), so it
            // tolerates the levelling; what we assert is the absence of any apply.
            alignSeqs(mvh);
            clearPendingProposals(mvh);
            const leader = findLeader(mvh);
            assert.ok(leader, 'no leader identified');

            const victims = mvh.hubs.filter((h) => h !== leader).slice(0, faults + 1);
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
                        'hub ' + i + ' applied a change that lacked quorum (only ' + (quorum - 1) + ' of ' + count + ' live, need ' + quorum + ')');
                }
            } finally {
                restores.forEach((r) => r());
                clearPendingProposals(mvh);
            }
        });

        it('SAFETY: a forged-digest PRE_PREPARE is rejected with no state change', async function () {
            const COIN = 'BTC', NET = 'regtest', MODULE = 'node';
            const forgedValue = String(count) + '60666';
            const target = mvh.hubs[mvh.hubs.length - 1];   // any honest hub
            const seq = 9100;                               // well above any applied seq

            const before = await target.db.getConfig(COIN, NET, MODULE);
            assert.notStrictEqual(before.GAS_PRICE, forgedValue, 'precondition: forged value not already set');

            await target.consensus._handlePrePrepare(
                forgedPrePrepare(seq, { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: forgedValue } } } }, seed.blockIndex, target.consensus.validatorSet[0])
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
            const configA = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: String(count) + '111' } } } };
            const configB = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: String(count) + '222' } } } };
            const digestA = follower.consensus._digest(configA);
            const digestB = follower.consensus._digest(configB);
            // A PRE_PREPARE is only accepted from the rotation-designated leader for
            // (seq, view) with a registered sender. An equivocating leader is still
            // the LEGITIMATE leader; it just emits two conflicting configs for one seq.
            const N = follower.consensus.validatorSet.length;
            const leader = follower.consensus.validatorSet[(seq + view) % N];
            // Carries the leader's SIGNING KEY as well as its address: admission is
            // keyed on the proven key, which transport stamps and verifies before a
            // handler runs. Injecting into the handler skips that, so the fixture
            // supplies it, otherwise the envelope is unattributable and dropped.
            const env = (digest, config) => ({
                sender: leader.addr,
                sig_pubkey: leader.pubkey,
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
}

byzantineScaleSuite({ count: 7,  quorum: 5, faults: 2, basePort: 31000, peerWaitMs: 12000 });
byzantineScaleSuite({ count: 10, quorum: 7, faults: 3, basePort: 30000, peerWaitMs: 14000 });
