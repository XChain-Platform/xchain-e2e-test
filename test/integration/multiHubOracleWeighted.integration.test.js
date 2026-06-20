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
 * L2 integration: STAKE_WEIGHTED_QUORUM (WI-1) for the price capability:
 * oracle PRICE-round finalization (Suite A3 of the regtest e2e plan).
 *
 * Drives the REAL OracleConsensus PBFT round (ORACLE_PROPOSE -> ORACLE_PREPARE ->
 * ORACLE_COMMIT -> price_snapshots) over live P2P with a SOURCE-keyed weight
 * snapshot, proving the WI-1 thesis for the price capability:
 *
 *   - NEGATIVE: 3 live small-stake hubs (a COUNT majority) hold only 3000/10000
 *     stake; a whale source sits in the weight snapshot (counts toward S) but is
 *     OFFLINE. The 3 live hubs co-sign, the weighted tally (3·3000 !> 2·10000)
 *     refuses -> NO price_snapshots row finalizes on any hub.
 *   - POSITIVE: 4 live hubs with uneven weights (4000/3000/2000/1000, no single
 *     source >= 2/3) -> multi-signer weighted quorum -> the identical price_snapshots
 *     row lands on every hub.
 *
 * The harness doesn't start the oracle subsystem, so we attach a real
 * OracleConsensus per hub (start() registers the P2P handlers) WITHOUT
 * OracleRound.start() (no price-fetch cadence) and inject identical submissions
 * directly into each hub's round buffer, then call finalizeRound() on every hub.
 * OracleConsensus reads hub.network live (no cached-network gotcha), so
 * seedWeightSnapshot's hub.network='regtest' is enough to activate weighting.
 * Leader = validatorSet[round % N] over the REGISTERED (live) set, so the offline
 * whale (never registered) can't be elected leader.
 *
 * The weighted quorum tallies signer STAKE over pending.signatures.keys() (the
 * only pubkey-keyed record; prepares/commits are address-keyed). This is the exact
 * path the indexer re-verifies. No chain; disposable Docker MariaDB; skips when
 * neither an env DB nor Docker is available. regtest activation = 0 (always weighted).
 *
 * Spec: claude/reports/2026-06-14_cross-chain-quorum-security-spec.md §3.7, §10;
 * plan §A3.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const path   = require('path');
const assert = require('assert');
const { MultiValidatorHub }    = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../helpers/seededWeightSnapshot');

function hubRequire(rel) { return require(path.resolve(__dirname, '../../../xchain-hub', rel)); }
const OracleConsensus = hubRequire('src/OracleConsensus.js');
const OracleRound     = hubRequire('src/OracleRound.js');

const PEER_WAIT_MS = 8000;
const SETTLE_MS    = 6000;
const BLOCK_INDEX  = 100;       // BTC block boundary the round locks the snapshot at (>=0 -> weighted on regtest)
const BLOCK_TIME   = 1700000000;
const ROUND        = 100;
const PAIR         = 'BTC/USD';
const PRICE        = '60000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Attach a real OracleConsensus to each hub: start() registers the ORACLE_*
// P2P handlers; we deliberately skip OracleRound.start() so no price-fetch
// cadence races our manual round. Returns a teardown.
async function attachOracle(mvh) {
    const stops = [];
    for (const hub of mvh.hubs) {
        const round = new OracleRound(hub);
        const oc    = new OracleConsensus(hub, round);
        round.setConsensus(oc);
        oc.setValidatorSet(await hub._loadValidatorSet());   // for leader rotation
        await oc.start();                                    // registers P2P handlers (no cadence)
        hub._wtOracle = oc;
        hub._wtRound  = round;
        stops.push(() => oc.stop && oc.stop());
    }
    return { stop() { stops.forEach((s) => { try { s(); } catch (_) {} }); } };
}

// Inject the SAME submission set (one price per live hub addr) into every hub's
// round buffer so each independently aggregates the identical canonical and the
// leader's proposal verifies on every follower.
function injectSubmissions(mvh) {
    const addrs = mvh.hubs.map((h) => h.getPeerManager().validatorAddr);
    for (const hub of mvh.hubs) {
        const subs = new Map();
        for (const addr of addrs) subs.set(addr, { prices: [{ coinPair: PAIR, price: PRICE }] });
        hub._wtRound.submissions.set(ROUND, subs);
    }
}

async function finalizeAll(mvh) {
    await Promise.all(mvh.hubs.map((h) => h._wtOracle.finalizeRound(ROUND, BLOCK_INDEX, BLOCK_TIME).catch(() => {})));
    await sleep(SETTLE_MS);
}

async function snapshotRows(hub) {
    return hub.db.doQuery(
        'SELECT * FROM price_snapshots WHERE round_number = ? AND coin_pair = ?',
        [ROUND, PAIR]);
}

describe('MultiValidatorHub: STAKE_WEIGHTED_QUORUM price PBFT round (WI-1 Suite A3, L2)', function () {
    this.timeout(240_000);

    describe('a stake-minority (count-majority) of live hubs cannot finalize a price round', function () {
        let db, mvh, seed, oracle;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping A3 (negative): no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: 3, basePort: 33400, startAttestation: false });
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
            oracle = await attachOracle(mvh);
            injectSubmissions(mvh);
            // S = 10000; the 3 live signers hold 3000.
        });

        after(async function () {
            if (oracle) oracle.stop();
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('the 3 live signers are a stake minority: no price snapshot is stored on any hub', async function () {
            await finalizeAll(mvh);
            for (let i = 0; i < mvh.hubs.length; i++) {
                const rows = await snapshotRows(mvh.hubs[i]);
                assert.strictEqual(rows.length, 0,
                    'hub ' + i + ' finalized a price a STAKE minority must never carry (got ' + rows.length + ' rows)');
            }
        });
    });

    describe('a healthy weighted federation finalizes the price on every hub', function () {
        let db, mvh, seed, oracle;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping A3 (positive): no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: 4, basePort: 33500, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            const ids = mvh.identities;
            // Uneven weights, no single source >= 2/3 (S=10000, 2S/3~6666): the
            // weighted quorum needs >=2 distinct sources -> exercises the multi-signer
            // aggregation path.
            seed = seedWeightSnapshot(mvh, {
                blockIndex: BLOCK_INDEX,
                validators: [
                    { pubkey: ids[0].pubkeyHex, source: 'sA', weight: '4000' },
                    { pubkey: ids[1].pubkeyHex, source: 'sB', weight: '3000' },
                    { pubkey: ids[2].pubkeyHex, source: 'sC', weight: '2000' },
                    { pubkey: ids[3].pubkeyHex, source: 'sD', weight: '1000' },
                ],
            });
            oracle = await attachOracle(mvh);
            injectSubmissions(mvh);
        });

        after(async function () {
            if (oracle) oracle.stop();
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('the weighted quorum is reached: the identical price snapshot lands on EVERY hub', async function () {
            await finalizeAll(mvh);
            const seen = [];
            for (let i = 0; i < mvh.hubs.length; i++) {
                const rows = await snapshotRows(mvh.hubs[i]);
                assert.strictEqual(rows.length, 1, 'hub ' + i + ' must hold exactly one finalized price snapshot (got ' + rows.length + ')');
                assert.strictEqual(String(rows[0].price), PRICE + '.00000000',
                    'hub ' + i + ' stored an unexpected price (got ' + rows[0].price + ')');
                assert.ok(Number(rows[0].validator_count) >= 2,
                    'hub ' + i + ' expected >= 2 weighted signers, got ' + rows[0].validator_count);
                seen.push(String(rows[0].price));
            }
            assert.strictEqual(new Set(seen).size, 1, 'all hubs must agree on the finalized price');
        });
    });
});
