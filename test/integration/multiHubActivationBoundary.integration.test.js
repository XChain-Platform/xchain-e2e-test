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
 * L2 integration — STAKE_WEIGHTED_QUORUM (WI-1) ACTIVATION BOUNDARY.
 *
 * Suite B from claude/reports/2026-06-15_wi1-regtest-e2e-plan.md §B. Proves the
 * count→weighted transition is a clean, fork-free flag-day: the SAME federation,
 * the SAME live signer set, evaluated one block BELOW the activation height
 * (legacy COUNT rule) vs one block ABOVE (stake-WEIGHTED rule), and EVERY hub
 * must make the IDENTICAL finalize/no-finalize decision at each block. A hub that
 * flipped early (or late) would fork the ledger at the boundary — this asserts
 * none does.
 *
 * Driver: the config-change PBFT engine (hub-internal, no indexer / no chain) —
 * the same engine proven in multiHubConsensusWeighted.integration.test.js. We
 * drive it across the boundary by stubbing _resolveBtcLatestBlock to a synthetic
 * block on each round and stubbing BOTH the COUNT snapshot (getActiveValidator-
 * Snapshot) and the WEIGHT snapshot (getActiveWeightSnapshot) with the SAME
 * 4-member set, so only the activation gate — not the validator set — changes
 * between rounds.
 *
 *   B1 boundary parity — fixture: 3 live small-stake hubs + 1 offline whale
 *     (in the snapshot, never votes). S = 10000, the 3 live hold 3000.
 *       • block ACT-1 (COUNT): count quorum = 3 (N=4), the 3 live hubs meet it →
 *         config APPLIES on every hub.
 *       • block ACT+1 (WEIGHTED): 3·3000 = 9000 !> 2·10000 = 20000 → config does
 *         NOT apply on any hub.
 *     The decision flips with the rule, uniformly across the federation.
 *
 *   B2 single-operator regression — 1 hub is the whole snapshot, so it finalizes
 *     on its own signature in BOTH modes (the quorum===0 fast path; weighted S=
 *     its own stake gives 3S>2S). Assert immediate apply below AND above.
 *
 * REQUIRES a non-zero regtest activation height in xchain-hub/src/
 * stake_weighted_quorum.js (regtest is 0 by default = always weighted, so the
 * COUNT side cannot be reached). Set regtest to e.g. 120 in all three swq copies
 * for the run, then revert (plan §B). The suite SKIPS with a clear message when
 * the height is still 0 so it never silently passes as a weighted-only test.
 *
 * Spec: claude/reports/2026-06-14_cross-chain-quorum-security-spec.md §3.4, §3.6,
 * §10.4; plan §B.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub }   = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const swq = require('../../../xchain-hub/src/stake_weighted_quorum.js');

const ACT = parseInt(swq.STAKE_WEIGHTED_QUORUM_ACTIVATION.regtest);

const PEER_WAIT_MS  = 8000;
const APPLY_WAIT_MS = 4000;   // COMMIT propagation + follower _applyConfig
const STALL_WAIT_MS = 6000;   // long enough to confirm a round does NOT finalize

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findLeader(mvh) {
    return mvh.hubs.find((h) => {
        const l = h.consensus._getLeader(h.consensus.seq + 1);
        return l && l.addr === h.consensus.peerManager.validatorAddr;
    });
}

// Stub BOTH the count and weight whole-federation snapshots with the SAME member
// set, and drive the round block via a shared mutable getter so a single fixture
// can be evaluated on either side of the activation height. `members` is
// [{pubkey, source, weight}] (weight doubles as the count snapshot `amount`).
function seedBoundarySnapshot(mvh, members, getBlock) {
    const sources    = new Set(members.map((m) => String(m.source)));
    const countVals  = members.map((m) => ({ pubkey: m.pubkey, amount: String(m.weight) }));
    const weightVals = members.map((m) => ({ pubkey: m.pubkey, source: String(m.source), weight: String(m.weight) }));
    const countBase  = { validators: countVals,  count: members.length };
    const weightBase = { validators: weightVals, count: members.length, sourceCount: sources.size };
    const freshCount  = () => Object.assign({}, countBase,  { validators: countVals.slice(),  blockIndex: getBlock() });
    const freshWeight = () => Object.assign({}, weightBase, { validators: weightVals.slice(), blockIndex: getBlock() });

    const restores = [];
    for (const hub of mvh.hubs) {
        const cs   = hub.capabilitySnapshot;
        const orig = {
            activeV: cs.getActiveValidatorSnapshot,
            getSnap: cs.getSnapshot,
            activeW: cs.getActiveWeightSnapshot,
            getW:    cs.getWeightSnapshot,
            block:   hub._resolveBtcLatestBlock,
            net:     hub.network,
        };
        cs.getActiveValidatorSnapshot = async () => freshCount();
        cs.getSnapshot                = async () => freshCount();
        cs.getActiveWeightSnapshot    = async () => freshWeight();
        cs.getWeightSnapshot          = async () => freshWeight();
        hub._resolveBtcLatestBlock    = async () => getBlock();
        hub.network                   = 'regtest';
        restores.push(() => {
            cs.getActiveValidatorSnapshot = orig.activeV;
            cs.getSnapshot                = orig.getSnap;
            cs.getActiveWeightSnapshot    = orig.activeW;
            cs.getWeightSnapshot          = orig.getW;
            hub._resolveBtcLatestBlock    = orig.block;
            hub.network                   = orig.net;
        });
    }
    return { restore() { restores.forEach((r) => r()); restores.length = 0; } };
}

describe('MultiValidatorHub — STAKE_WEIGHTED_QUORUM activation boundary (WI-1 Suite B, L2)', function () {
    this.timeout(300_000);

    before(function () {
        if (!Number.isFinite(ACT) || ACT < 2) {
            console.log(
                'Skipping WI-1 activation-boundary suite — regtest STAKE_WEIGHTED_QUORUM_ACTIVATION is ' +
                ACT + ' (must be ≥2 to reach the COUNT side). Set regtest to e.g. 120 in all three ' +
                'stake_weighted_quorum.js copies + constants.js for this run, then revert (plan §B).');
            this.skip();
        }
    });

    // ── B1 — boundary parity: same fixture, decision flips with the rule ──
    //
    // The two sides run on SEPARATE fresh federations (each at seq 0) because the
    // PBFT leader rotates by seq — a second round in the same federation lands on
    // a different leader and findLeader (proven at seq 0) wouldn't resolve it. The
    // no-fork property is unaffected: each side is asserted across EVERY hub of its
    // federation, and only the activation gate differs between them — the validator
    // set, the live-signer ratio, and the snapshot are identical. The 3 live hubs
    // are a COUNT majority (3 of N=4) but a STAKE minority (3000/10000).
    const MEMBERS = (ids) => [
        { pubkey: ids[0].pubkeyHex, source: 'sA',    weight: '1000' },
        { pubkey: ids[1].pubkeyHex, source: 'sB',    weight: '1000' },
        { pubkey: ids[2].pubkeyHex, source: 'sC',    weight: '1000' },
        { pubkey: 'ff'.repeat(32),  source: 'whale', weight: '7000' },   // offline
    ];

    describe('B1a — BELOW the height the COUNT rule applies on every hub', function () {
        let db, mvh, seed;
        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping B1a — no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: 3, basePort: 32200 });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            seed = seedBoundarySnapshot(mvh, MEMBERS(mvh.identities), () => ACT - 1);
        });
        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('count quorum (3 of N=4) finalizes the change on EVERY hub', async function () {
            assert.ok(!swq.isStakeWeightedQuorumActive(ACT - 1, 'regtest'),
                'block ' + (ACT - 1) + ' should be BELOW the activation height');
            const COIN = 'BTC', NET = 'regtest', MODULE = 'node', VALUE = '5151';
            const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: VALUE } } } };
            const leader = findLeader(mvh);
            assert.ok(leader, 'no round leader among the live hubs');

            await leader.addParametersFromJson(config);   // resolves on COUNT quorum
            await sleep(APPLY_WAIT_MS);

            for (let i = 0; i < mvh.hubs.length; i++) {
                const cfg = await mvh.hubs[i].db.getConfig(COIN, NET, MODULE);
                assert.strictEqual(cfg && cfg.GAS_PRICE, VALUE,
                    'hub ' + i + ' did not apply under the count rule below the boundary (got ' + JSON.stringify(cfg) + ')');
            }
        });
    });

    describe('B1b — ABOVE the height the WEIGHTED rule blocks the SAME set on every hub', function () {
        let db, mvh, seed;
        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping B1b — no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: 3, basePort: 32250 });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            seed = seedBoundarySnapshot(mvh, MEMBERS(mvh.identities), () => ACT + 1);
        });
        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('a stake minority (3000/10000) never finalizes — config applies on NO hub', async function () {
            assert.ok(swq.isStakeWeightedQuorumActive(ACT + 1, 'regtest'),
                'block ' + (ACT + 1) + ' should be AT/ABOVE the activation height');
            const COIN = 'BTC', NET = 'regtest', MODULE = 'node', VALUE = '9999';
            const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: VALUE } } } };
            const leader = findLeader(mvh);
            assert.ok(leader, 'no round leader among the live hubs');

            // Stake-minority → never reaches weighted quorum → the propose promise
            // rejects on timeout; fire-and-forget, assert no-apply on every hub.
            leader.addParametersFromJson(config).catch(() => {});
            await sleep(STALL_WAIT_MS);

            for (let i = 0; i < mvh.hubs.length; i++) {
                const cfg = await mvh.hubs[i].db.getConfig(COIN, NET, MODULE);
                assert.notStrictEqual(cfg && cfg.GAS_PRICE, VALUE,
                    'hub ' + i + ' applied a config a STAKE minority must never finalize above the boundary');
            }
        });
    });

    // ── B2 — single-operator finalizes on its own signature in BOTH modes ──
    describe('B2 — single-operator regression across the boundary', function () {
        let db, mvh, seed, currentBlock;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping B2 — no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: 1, basePort: 32300 });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            const ids = mvh.identities;
            const members = [{ pubkey: ids[0].pubkeyHex, source: 'solo', weight: '5000' }];
            currentBlock = ACT - 1;
            seed = seedBoundarySnapshot(mvh, members, () => currentBlock);
            // N=1 → getQuorum 0 → single-node fast path in BOTH modes.
        });

        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('finalizes immediately on its own signature below the boundary', async function () {
            currentBlock = ACT - 1;
            const COIN = 'BTC', NET = 'regtest', MODULE = 'node', VALUE = '111';
            const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: VALUE } } } };
            await mvh.hubs[0].addParametersFromJson(config);
            await sleep(APPLY_WAIT_MS);
            const cfg = await mvh.hubs[0].db.getConfig(COIN, NET, MODULE);
            assert.strictEqual(cfg && cfg.GAS_PRICE, VALUE, 'sole operator did not finalize below the boundary');
        });

        it('finalizes immediately on its own signature above the boundary', async function () {
            currentBlock = ACT + 1;
            const COIN = 'BTC', NET = 'regtest', MODULE = 'node', VALUE = '222';
            const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: VALUE } } } };
            await mvh.hubs[0].addParametersFromJson(config);
            await sleep(APPLY_WAIT_MS);
            const cfg = await mvh.hubs[0].db.getConfig(COIN, NET, MODULE);
            assert.strictEqual(cfg && cfg.GAS_PRICE, VALUE, 'sole operator did not finalize above the boundary');
        });
    });
});
