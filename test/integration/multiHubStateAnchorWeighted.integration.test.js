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
 * L2 integration — STAKE_WEIGHTED_QUORUM (WI-1) for the oracle_publish
 * capability: state-checkpoint finalization (Suite A5 of the regtest e2e plan).
 *
 * The weighted twin of multiHubStateAnchor.integration.test.js, restricted to the
 * checkpoint round (StateCheckpointEngine: XCHK_SIGN_REQ → XCHK_SIGN →
 * XCHK_FINALIZED). Drives the REAL round over live P2P with a SOURCE-keyed weight
 * snapshot, proving the WI-1 thesis for oracle_publish:
 *
 *   - NEGATIVE: 3 live small-stake hubs (a COUNT majority — they alone would meet
 *     2f+1) hold only 3000/10000 stake; a whale source sits in the snapshot
 *     (counts toward S) but is OFFLINE. The 3 live hubs co-sign, the weighted
 *     tally (3·3000 = 9000 !> 2·10000 = 20000) refuses → NO checkpoint finalizes
 *     on any hub. The regression the old count rule would have missed.
 *   - POSITIVE: the whale is online (4th hub) → the weighted quorum is reached →
 *     the identical 3+-signed checkpoint lands in EVERY hub's state_checkpoints.
 *
 * Election seam: the cadence leader is pubkeys[snapshot_block % N] over the SORTED
 * oracle_publish set. The offline whale's placeholder pubkey 'ff'*32 is the
 * maximum 32-byte value, so it sorts LAST (index N-1); snapshot_block 100 → index
 * 100 % 4 = 0 → always a live hub leads. (Otherwise an offline-leader round would
 * never start, masking the stake test.)
 *
 * Gotcha: StateCheckpointEngine caches this.network at construction (before
 * seedWeightSnapshot sets hub.network), so we set cps.network='regtest' per hub —
 * otherwise the engine resolves an unknown network and the weighted gate is OFF.
 *
 * No chain: the indexer view is stubbed (_indexerCall → TIP); disposable Docker
 * MariaDB; skips when neither an env DB nor Docker is available. Runs with regtest
 * activation = 0 (always weighted) — no constant edit needed.
 *
 * Spec: claude/reports/2026-06-14_cross-chain-quorum-security-spec.md §3.7, §10;
 * plan §A5.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub, ValidatorIdentity } = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../helpers/seededWeightSnapshot');
const eq = require('../../../xchain-hub/src/equivocation_header.js');

const PEER_WAIT_MS = 8000;
const SETTLE_MS    = 6000;
const BLOCK_INDEX  = 100;       // seeded BTC anchor (snapshot + election block); 100 % 4 = 0 → live leader

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Identical stubbed "indexer" tip on every hub — the checkpoint engine's
// getblockhashes view (network MUST be set, the engine refuses a network-agnostic
// checkpoint).
const TIP = {
    coin: 'BTC', network: 'regtest', block_index: 500, block_time: 1700000000,
    block_hash: 'c0'.repeat(32), ledger_hash: 'a1'.repeat(32),
    actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32)
};

// Per-hub: pin the snapshot/election block, scope to BTC, stub the indexer view to
// the shared TIP, and (critical) set the engine's cached network so the weighted
// gate is active.
function wireCheckpointEngine(mvh) {
    for (const hub of mvh.hubs) {
        const cps = hub.stateCheckpoints;
        cps.network        = 'regtest';   // engine cached '' at construction (pre-seed)
        cps.chains         = ['BTC'];
        cps.confirmations  = 0;
        cps.indexers.BTC   = { url: 'http://stubbed', key: '' };
        cps._indexerCall   = async () => Object.assign({}, TIP);
    }
}

async function tickAll(mvh) {
    await Promise.all(mvh.hubs.map((h) => h.stateCheckpoints._tick().catch(() => {})));
    await sleep(SETTLE_MS);
}

async function checkpointRows(hub) {
    return hub.db.doQuery(
        'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ?',
        ['BTC', 'regtest', TIP.block_index]);
}

describe('MultiValidatorHub — STAKE_WEIGHTED_QUORUM oracle_publish checkpoint (WI-1 Suite A5, L2)', function () {
    this.timeout(240_000);

    // ── NEGATIVE: count-majority / stake-minority of live hubs cannot finalize ──
    describe('a stake-minority (count-majority) of live hubs cannot finalize a checkpoint', function () {
        let db, mvh, seed;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping A5 (negative) — no env DB and Docker unavailable'); this.skip(); }
            // 3 live small hubs; a 4th WHALE source is in the snapshot but offline.
            mvh = new MultiValidatorHub({ count: 3, basePort: 33200, startCrossChain: true, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            const ids = mvh.identities;
            seed = seedWeightSnapshot(mvh, {
                blockIndex: BLOCK_INDEX,
                validators: [
                    { pubkey: ids[0].pubkeyHex, source: 'sA',    weight: '1000' },
                    { pubkey: ids[1].pubkeyHex, source: 'sB',    weight: '1000' },
                    { pubkey: ids[2].pubkeyHex, source: 'sC',    weight: '1000' },
                    { pubkey: 'ff'.repeat(32),  source: 'whale', weight: '7000' },   // offline
                ],
            });
            wireCheckpointEngine(mvh);
            // S = 10000; the 3 live hubs hold 3000.
        });

        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('the 3 live signers are a stake minority — no checkpoint is stored on any hub', async function () {
            await tickAll(mvh);
            for (let i = 0; i < mvh.hubs.length; i++) {
                const rows = await checkpointRows(mvh.hubs[i]);
                assert.strictEqual(rows.length, 0,
                    'hub ' + i + ' finalized a checkpoint a STAKE minority must never carry (got ' + rows.length + ' rows)');
            }
        });
    });

    // ── POSITIVE: a healthy weighted federation finalizes the checkpoint ──
    describe('a healthy weighted federation (whale online) finalizes on every hub', function () {
        let db, mvh, seed;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping A5 (positive) — no env DB and Docker unavailable'); this.skip(); }
            // 4 hubs: three small + one whale, all live (uneven stake).
            mvh = new MultiValidatorHub({ count: 4, basePort: 33300, startCrossChain: true, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            const ids = mvh.identities;
            // Uneven weights where NO single source clears 2/3 (S=10000, 2S/3≈6666):
            // the weighted quorum requires ≥2 distinct sources to co-sign, so this
            // exercises the multi-signer weighted aggregation path (not the single
            // supermajority fast path).
            seed = seedWeightSnapshot(mvh, {
                blockIndex: BLOCK_INDEX,
                validators: [
                    { pubkey: ids[0].pubkeyHex, source: 'sA', weight: '4000' },
                    { pubkey: ids[1].pubkeyHex, source: 'sB', weight: '3000' },
                    { pubkey: ids[2].pubkeyHex, source: 'sC', weight: '2000' },
                    { pubkey: ids[3].pubkeyHex, source: 'sD', weight: '1000' },
                ],
            });
            wireCheckpointEngine(mvh);
            // S = 10000; e.g. 4000+3000 = 7000 → 3·7000 > 2·10000 → finalizes.
        });

        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('the weighted quorum is reached — the identical checkpoint lands on EVERY hub', async function () {
            await tickAll(mvh);

            const rows = [];
            for (let i = 0; i < mvh.hubs.length; i++) {
                const r = await checkpointRows(mvh.hubs[i]);
                assert.strictEqual(r.length, 1, 'hub ' + i + ' must hold exactly one finalized checkpoint (got ' + r.length + ')');
                rows.push(r[0]);
            }

            // Every hub holds the identical checkpoint, with weighted-quorum sigs
            // that verify against the canonical. At/above the EQUIV flag-day (regtest
            // activates at genesis → always on) the signed bytes are the v0 raw wrapped
            // in the uniform header (TAG=XCHECKPOINT, VIEW=0); gate keys on snapshot_block.
            const raw = ['XCHECKPOINT', 'BTC', 'regtest', String(TIP.block_index), TIP.block_hash,
                         TIP.ledger_hash, TIP.actions_hash, TIP.contract_hash,
                         String(rows[0].checkpoint_seq), String(BLOCK_INDEX)].join('|');
            const canonical = eq.isEquivHeaderActive(BLOCK_INDEX, 'regtest')
                ? eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
                    'BTC|regtest|' + TIP.block_index + '|' + rows[0].checkpoint_seq, 0, raw)
                : raw;
            for (let i = 0; i < rows.length; i++) {
                assert.strictEqual(rows[i].ledger_hash, TIP.ledger_hash, 'hub ' + i + ' diverged on ledger_hash');
                const sigs = JSON.parse(rows[i].validator_signatures);
                const verifying = new Set();
                for (const s of sigs)
                    if (ValidatorIdentity.verify(canonical, s.sig, s.pubkey)) verifying.add(s.pubkey);
                // Count-INDEPENDENT: this weighted fixture reaches quorum at 2 of 4 signers
                // (4000+3000 > 2·S/3), so the checkpoint can legitimately finalize with 2 sigs.
                // Assert EVERY stored sig verifies over the canonical, not a fixed >=3 floor.
                assert.ok(sigs.length >= 1, 'hub ' + i + ' must carry at least one quorum sig');
                assert.strictEqual(verifying.size, sigs.length,
                    'hub ' + i + ': every stored sig must verify over the canonical (got ' + verifying.size + '/' + sigs.length + ')');
            }
            const distinct = new Set(rows.map((r) => r.ledger_hash + '|' + r.checkpoint_seq));
            assert.strictEqual(distinct.size, 1, 'all hubs must hold the identical checkpoint');
        });
    });
});
