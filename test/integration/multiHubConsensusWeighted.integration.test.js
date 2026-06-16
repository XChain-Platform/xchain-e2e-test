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
 * L2 integration — STAKE_WEIGHTED_QUORUM (WI-1) config-change PBFT.
 *
 * The weighted twin of multiHubConsensus.integration.test.js. Boots in-process
 * XChainHub validators with a SOURCE-keyed weight snapshot (seedWeightSnapshot)
 * so the federation runs the stake-weighted tally (3·Σ source-weight > 2·S), and
 * proves the WI-1 thesis end to end over real P2P:
 *
 *   - NEGATIVE (the crux): a set of live hubs that is a COUNT majority (meets the
 *     legacy 2f+1 quorum) but a STAKE minority CANNOT apply a config change — the
 *     whale source sits in the snapshot (counts toward S) but is offline, so its
 *     weight is never voted. Under the old count rule these 3 votes WOULD apply;
 *     under WI-1 they must not.
 *   - POSITIVE: a healthy weighted federation (whale online) reaches the weighted
 *     quorum and applies the change on EVERY hub — the weighted path doesn't
 *     deadlock a normal round.
 *
 * No indexer / no chain: seedWeightSnapshot injects the snapshot + sets
 * hub.network='regtest' (activation height 0 → weighting ON). Disposable Docker
 * MariaDB; skips cleanly when neither an env DB nor Docker is available.
 *
 * Spec: claude/reports/2026-06-14_cross-chain-quorum-security-spec.md §3.7, §10.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub }   = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../helpers/seededWeightSnapshot');

const PEER_WAIT_MS  = 8000;
const APPLY_WAIT_MS = 4000;   // COMMIT propagation + follower _applyConfig
const STALL_WAIT_MS = 6000;   // long enough to confirm a round does NOT finalize

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Find the hub that is the round leader for the next sequence (all hubs share the
// same sorted validator set + seq, so exactly one matches).
function findLeader(mvh) {
    return mvh.hubs.find((h) => {
        const l = h.consensus._getLeader(h.consensus.seq + 1);
        return l && l.addr === h.consensus.peerManager.validatorAddr;
    });
}

describe('MultiValidatorHub — STAKE_WEIGHTED_QUORUM config-change PBFT (WI-1, L2)', function () {
    this.timeout(240_000);

    // ── NEGATIVE: count-majority / stake-minority cannot finalize ────────────
    describe('a stake-minority (count-majority) of live hubs cannot apply a config', function () {
        let db, mvh, seed;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping weighted-PBFT L2 (negative) — no env DB and Docker unavailable'); this.skip(); }
            // 3 small hubs live; a 4th WHALE source is in the snapshot but has no hub
            // (offline) so its weight is never voted.
            mvh = new MultiValidatorHub({ count: 3, basePort: 32000 });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            const ids = mvh.identities;
            seed = seedWeightSnapshot(mvh, {
                validators: [
                    { pubkey: ids[0].pubkeyHex, source: 'sA',    weight: '1000' },
                    { pubkey: ids[1].pubkeyHex, source: 'sB',    weight: '1000' },
                    { pubkey: ids[2].pubkeyHex, source: 'sC',    weight: '1000' },
                    // Whale source — in the snapshot (S includes it) but offline.
                    { pubkey: 'ff'.repeat(32),  source: 'whale', weight: '7000' },
                ],
            });
            // S = 10000; the 3 live hubs hold 3000. 3·3000 = 9000 !> 2·10000 = 20000.
        });

        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('count quorum is met (3 of 4) yet the weighted tally is not — config never applies', async function () {
            // Sanity: the round-locked COUNT quorum is 3, which the 3 live hubs WOULD
            // satisfy under the legacy rule — so a non-apply proves weighting gates.
            const countQuorum = mvh.hubs[0].consensus.hub.capabilitySnapshot.getQuorum(seed.snapshot);
            assert.strictEqual(countQuorum, 3, 'expected count quorum 3 for snapshot N=4');

            const COIN = 'BTC', NET = 'regtest', MODULE = 'node', VALUE = '5150';
            const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: VALUE } } } };
            const leader = findLeader(mvh);
            assert.ok(leader, 'no round leader among the live hubs');

            // The round can never reach weighted quorum, so the propose promise will
            // reject on timeout — fire-and-forget and assert the change never lands.
            leader.addParametersFromJson(config).catch(() => {});
            await sleep(STALL_WAIT_MS);

            for (let i = 0; i < mvh.hubs.length; i++) {
                const cfg = await mvh.hubs[i].db.getConfig(COIN, NET, MODULE);
                const got = cfg ? cfg.GAS_PRICE : undefined;
                assert.notStrictEqual(got, VALUE,
                    'hub ' + i + ' applied a config that a STAKE minority should never finalize');
            }
        });
    });

    // ── POSITIVE: a healthy weighted federation applies the change ───────────
    describe('a healthy weighted federation (whale online) applies the config on every hub', function () {
        let db, mvh, seed;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping weighted-PBFT L2 (positive) — no env DB and Docker unavailable'); this.skip(); }
            // 4 hubs: three small + one whale, all live (uneven stake).
            mvh = new MultiValidatorHub({ count: 4, basePort: 32100 });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            const ids = mvh.identities;
            seed = seedWeightSnapshot(mvh, {
                validators: [
                    { pubkey: ids[0].pubkeyHex, source: 'sA',    weight: '1000' },
                    { pubkey: ids[1].pubkeyHex, source: 'sB',    weight: '1000' },
                    { pubkey: ids[2].pubkeyHex, source: 'sC',    weight: '1000' },
                    { pubkey: ids[3].pubkeyHex, source: 'whale', weight: '7000' },
                ],
            });
            // S = 10000; all four (incl. whale) vote → 3·10000 > 2·10000 → applies.
        });

        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('a leader-proposed config change reaches weighted quorum and applies on EVERY hub', async function () {
            const COIN = 'BTC', NET = 'regtest', MODULE = 'node', VALUE = '700700';
            const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: VALUE } } } };
            const leader = findLeader(mvh);
            assert.ok(leader, 'no round leader could be identified');

            await leader.addParametersFromJson(config);   // resolves on weighted COMMIT quorum
            await sleep(APPLY_WAIT_MS);

            for (let i = 0; i < mvh.hubs.length; i++) {
                const cfg = await mvh.hubs[i].db.getConfig(COIN, NET, MODULE);
                assert.strictEqual(cfg.GAS_PRICE, VALUE,
                    'hub ' + i + ' did not apply the weighted PBFT config change (got ' + JSON.stringify(cfg) + ')');
            }
        });
    });
});
