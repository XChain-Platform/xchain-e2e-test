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
 * Track C.2 — MULTI-HUB fiat oracle round → FIAT-dispenser consumption.
 *
 * C3 chained a SINGLE-validator fiat round → finalized BTC/USD row → the
 * indexer's real reversePriceMatch consumption. The multi-validator version was
 * the gap: nothing chained a REAL multi-hub PBFT fiat round (the federation path)
 * to that consumption leg. This closes it:
 *   1. drive a real 4-hub OracleConsensus PBFT round (weighted quorum, regtest)
 *      → identical finalized BTC/USD price_snapshots row on every hub;
 *   2. run the indexer's REAL reversePriceMatch (the exact FIAT-dispenser
 *      settlement logic) against that federated row → a FIAT Mode-1 dispenser
 *      settles; plus the 24h-window boundary.
 *
 * Round mechanics mirror multiHubOracleWeighted.integration.test.js; the
 * consumption leg mirrors the hub's oracleFiatDispenser.integration.test.js (C3):
 * Object.create(IndexerUtility.prototype) gives a constructor-free matcher (the
 * pricing helpers are pure mathjs, never touch indexer config). The indexer is
 * resolved by monorepo-relative path; on the in-process venue an ~/xchain-indexer
 * sibling must exist.
 *
 * regtest activates STAKE_WEIGHTED_QUORUM at 0 → the round uses the weighted
 * predicate; an uneven 4-source weight set (no source ≥ 2/3) finalizes via the
 * multi-signer path. Disposable Docker MariaDB; skips when unavailable.
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

// The REAL dispenser-side consumption logic lives in the indexer's Utility.
// reversePriceMatch + its bignumber helpers are pure (mathjs, never touch
// this.config), so Object.create(prototype) gives a constructor-free instance.
const IndexerUtility = require(path.resolve(__dirname, '../../../xchain-indexer/src/utility.js'));
function indexerMatcher() { return Object.create(IndexerUtility.prototype); }

const FIAT_DISPENSER_PRICE_WINDOW = 86400;   // indexer default (24h)

const PEER_WAIT_MS = 8000;
const SETTLE_MS    = 6000;
const BLOCK_INDEX  = 100;
const BLOCK_TIME   = 1700000000;
const ROUND        = 100;
const PAIR         = 'BTC/USD';
const PRICE        = '60000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attachOracle(mvh) {
    const stops = [];
    for (const hub of mvh.hubs) {
        const round = new OracleRound(hub);
        const oc    = new OracleConsensus(hub, round);
        round.setConsensus(oc);
        oc.setValidatorSet(await hub._loadValidatorSet());
        await oc.start();
        hub._wtOracle = oc;
        hub._wtRound  = round;
        stops.push(() => oc.stop && oc.stop());
    }
    return { stop() { stops.forEach((s) => { try { s(); } catch (_) {} }); } };
}

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

// Thin price-DB shim mirroring the indexer's getPricesInTimeRange, reading the
// SAME finalized price_snapshots the round just wrote (verbatim from C3).
function makePriceDb(hubDb) {
    return {
        getPricesInTimeRange: async (coinPair, startTime, endTime) => {
            const rows = await hubDb.doQuery(
                `SELECT price, round_number, block_timestamp
                   FROM price_snapshots
                  WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL
                    AND block_timestamp BETWEEN ? AND ?
               ORDER BY block_timestamp DESC`,
                [coinPair, startTime, endTime]
            );
            return rows.map(r => ({
                price:       r.price,
                roundNumber: Number(r.round_number),
                timestamp:   Number(r.block_timestamp)
            }));
        }
    };
}

describe('MultiValidatorHub — multi-hub fiat oracle round → FIAT dispenser consumption (C.2)', function () {
    this.timeout(240_000);

    let db, mvh, seed, oracle;

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping multi-hub fiat oracle — no env DB and Docker unavailable'); this.skip(); }
        mvh = new MultiValidatorHub({ count: 4, basePort: 26100, startAttestation: false });
        await mvh.start();
        await sleep(PEER_WAIT_MS);
        const ids = mvh.identities;
        // Uneven weights, no source ≥ 2/3 of S=10000 → multi-signer weighted quorum.
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

    it('a real multi-hub PBFT round finalizes the identical BTC/USD snapshot on every hub', async function () {
        await finalizeAll(mvh);
        const seen = [];
        for (let i = 0; i < mvh.hubs.length; i++) {
            const rows = await snapshotRows(mvh.hubs[i]);
            assert.strictEqual(rows.length, 1, 'hub ' + i + ' must hold exactly one finalized fiat snapshot (got ' + rows.length + ')');
            assert.strictEqual(String(rows[0].price), PRICE + '.00000000', 'hub ' + i + ' stored an unexpected price (got ' + rows[0].price + ')');
            seen.push(String(rows[0].price));
        }
        assert.strictEqual(new Set(seen).size, 1, 'all hubs must agree on the finalized fiat price');
    });

    it('the federated fiat row is consumed by a FIAT dispenser via the indexer reverse-match', async function () {
        const rows = await snapshotRows(mvh.hubs[0]);
        assert.strictEqual(rows.length, 1, 'expected the finalized fiat row from the prior round');
        const snapTs = Number(rows[0].block_timestamp);

        // FIAT Mode-1 dispenser: 60 USD/token, GET_COIN=BTC. btc_per_token =
        // 60/60000 = 0.001; buyer pays 0.0025 BTC → floor(0.0025/0.001) = 2 units.
        const match = await indexerMatcher().reversePriceMatch(
            '0.0025', '60', PAIR, snapTs + 1, FIAT_DISPENSER_PRICE_WINDOW, makePriceDb(mvh.hubs[0].db)
        );
        assert.notStrictEqual(match, null, 'dispenser reverse-match should consume the federated finalized snapshot');
        assert.strictEqual(match.units, 2, 'expected 2 dispensed units, got ' + (match && match.units));
        assert.strictEqual(Number(match.snapshot.price), 60000, 'reverse-match consumed an unexpected snapshot price');
    });

    it('does not settle when the dispense is outside the 24h price window', async function () {
        const rows = await snapshotRows(mvh.hubs[0]);
        const snapTs = Number(rows[0].block_timestamp);
        const match = await indexerMatcher().reversePriceMatch(
            '0.0025', '60', PAIR, snapTs + FIAT_DISPENSER_PRICE_WINDOW + 10, FIAT_DISPENSER_PRICE_WINDOW, makePriceDb(mvh.hubs[0].db)
        );
        assert.strictEqual(match, null, 'a snapshot older than the 24h window must not settle');
    });
});
