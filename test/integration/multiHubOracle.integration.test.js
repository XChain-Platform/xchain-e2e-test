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
 * L2 integration - oracle determinism across a multi-validator hub set
 *
 * Boots N=4 in-process XChainHub validators on a disposable DB, gives each its
 * own real OracleConsensus, and feeds every hub the SAME price submissions but
 * in a DIFFERENT arrival order (as the network would). Asserts the federation-
 * critical determinism property:
 *
 *   - every hub computes the IDENTICAL trimmed-median per pair;
 *   - every hub serializes the IDENTICAL canonical PRICE v0 payload (so the
 *     leader's aggregate is reproducible by every follower);
 *   - every hub SIGNS that payload with its own real identity, and every
 *     signature verifies against the shared canonical payload - i.e. any hub
 *     can validate any other's PRICE v0 signature. Divergence here silently
 *     stalls oracle rounds.
 *
 * Pairs with the pure unit guard xchain-hub/test/regression/oracle-determinism.
 * Coverage-matrix gap: Oracle L2/L4 were ⬜. Skips when no DB/Docker available.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const path   = require('path');
const assert = require('assert');
const { MultiValidatorHub }    = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedStakeSnapshot }    = require('../helpers/seededStakeSnapshot');

function hubRequire(rel) { return require(path.resolve(__dirname, '../../../xchain-hub', rel)); }
const OracleConsensus  = hubRequire('src/OracleConsensus.js');
const OracleRound      = hubRequire('src/OracleRound.js');
const ValidatorIdentity = hubRequire('src/ValidatorIdentity.js');

const COUNT        = 4;
const PEER_WAIT_MS = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same submissions, different arrival order per hub. v6 lists its pairs
// LTC-first so some orders build the aggregate array in a different pair order
// - the canonical (sorted) payload must absorb that.
const ENTRIES = [
    ['v0', [{ coinPair: 'BTC/USD', price: '59000' }, { coinPair: 'LTC/USD', price: '70' }]],
    ['v1', [{ coinPair: 'BTC/USD', price: '60000' }, { coinPair: 'LTC/USD', price: '72' }]],
    ['v2', [{ coinPair: 'BTC/USD', price: '60500' }, { coinPair: 'LTC/USD', price: '74' }]],
    ['v3', [{ coinPair: 'BTC/USD', price: '61000' }, { coinPair: 'LTC/USD', price: '76' }]],
    ['v4', [{ coinPair: 'BTC/USD', price: '61500' }, { coinPair: 'LTC/USD', price: '78' }]],
    ['v5', [{ coinPair: 'BTC/USD', price: '62000' }, { coinPair: 'LTC/USD', price: '80' }]],
    ['v6', [{ coinPair: 'LTC/USD', price: '81' },    { coinPair: 'BTC/USD', price: '999999' }]]
];
const ORDERS = [
    [0, 1, 2, 3, 4, 5, 6],
    [6, 5, 4, 3, 2, 1, 0],
    [3, 0, 6, 1, 5, 2, 4],
    [2, 6, 0, 4, 1, 3, 5]
];
const subsFor = (order) => new Map(order.map((i) => [ENTRIES[i][0], { prices: ENTRIES[i][1] }]));
const priceMap = (results) => Object.fromEntries(results.map((p) => [p.coinPair, p.price]));

describe('MultiValidatorHub - oracle determinism (L2)', function () {
    this.timeout(180_000);

    let db, mvh, seed;

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping oracle L2 - no env DB and Docker unavailable'); this.skip(); }
        mvh = new MultiValidatorHub({ count: COUNT, basePort: 33000 });
        await mvh.start();
        await sleep(PEER_WAIT_MS);
        seed = seedStakeSnapshot(mvh);
        // Give each booted hub its own oracle consensus engine (the harness
        // doesn't start oracle by default). Constructors start no timers.
        for (const hub of mvh.hubs) {
            hub._oracleConsensus = new OracleConsensus(hub, new OracleRound(hub));
        }
    });

    after(async function () {
        if (seed) seed.restore();
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
        if (db)  { await db.stop(); }
    });

    it('every hub computes the identical trimmed median from the same inputs', function () {
        const maps = mvh.hubs.map((h, i) => priceMap(h._oracleConsensus._aggregateAll(subsFor(ORDERS[i]))));
        for (let i = 1; i < maps.length; i++) {
            assert.deepStrictEqual(maps[i], maps[0], 'hub ' + i + ' diverged on the median');
        }
        // Outliers trimmed (1 per side): BTC drops 59000 + 999999 → median of
        // [60000,60500,61000,61500,62000] = 61000; LTC drops 70 + 81 → 76.
        assert.strictEqual(maps[0]['BTC/USD'], '61000.00000000');
        assert.strictEqual(maps[0]['LTC/USD'], '76.00000000');
    });

    it('every hub signs the IDENTICAL canonical payload, and all signatures cross-verify', function () {
        const round = 100, ts = 1700000000, btcHeight = 799000;  // #4232: height is in the signed canonical
        const signed = mvh.hubs.map((h, i) => {
            const agg = h._oracleConsensus._aggregateAll(subsFor(ORDERS[i]));
            return {
                payload: h._oracleConsensus._buildPriceV0Payload(round, ts, agg, btcHeight),
                sig:     h._oracleConsensus._signPriceV0(round, ts, agg, btcHeight)
            };
        });

        for (let i = 1; i < signed.length; i++) {
            assert.strictEqual(signed[i].payload, signed[0].payload,
                'hub ' + i + ' produced a different canonical payload - signatures cannot match');
        }

        const canonical = signed[0].payload;
        const pubkeys = new Set();
        signed.forEach((s, i) => {
            assert.ok(s.sig && s.sig.pubkey && s.sig.sig, 'hub ' + i + ' produced no signature');
            pubkeys.add(s.sig.pubkey);
            assert.ok(ValidatorIdentity.verify(canonical, s.sig.sig, s.sig.pubkey),
                'hub ' + i + ' signature does not verify against the canonical payload');
        });
        assert.strictEqual(pubkeys.size, COUNT, 'expected one distinct signing identity per hub');
    });
});
