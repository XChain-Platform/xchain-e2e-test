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
 * Track C.2: Byzantine fault tolerance for the price-oracle PBFT engine.
 *
 * Byzantine coverage existed for config-PBFT and DEX-PBFT but the oracle round
 * was only unit-tested. This drives the REAL OracleConsensus PBFT round over
 * live P2P with a silenced (partitioned) oracle validator, proving:
 *   - LIVENESS (f=1): one silent oracle validator does NOT stall the round.
 *     The honest 3-of-4 reach quorum and finalize the correct median on every
 *     honest hub; the silenced hub legitimately stores nothing.
 *   - SAFETY (2-of-4 down): with two oracle validators silenced, quorum (3) is
 *     unreachable → NO price_snapshots row finalizes on any hub.
 *
 * regtest activates STAKE_WEIGHTED_QUORUM at height 0, so the round uses the
 * weighted predicate (3·tally > 2·S). Four EQUAL-weight sources make that behave
 * exactly like a count quorum of 3 (3 distinct signers clear 2/3 of S; 2 do not),
 * giving the clean f=1 liveness / 2-of-4 safety boundary.
 *
 * Uses the new silenceOracleValidator() byzantine injector (test/helpers/
 * byzantineFaults.js). Helpers (attachOracle/injectSubmissions/finalizeAll) mirror
 * multiHubOracleWeighted.integration.test.js. Disposable Docker MariaDB; skips
 * cleanly when neither an env DB nor Docker is available.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const path   = require('path');
const assert = require('assert');
const { MultiValidatorHub }       = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb }    = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }      = require('../helpers/seededWeightSnapshot');
const { silenceOracleValidator }  = require('../helpers/byzantineFaults');

function hubRequire(rel) { return require(path.resolve(__dirname, '../../../xchain-hub', rel)); }
const OracleConsensus = hubRequire('src/OracleConsensus.js');
const OracleRound     = hubRequire('src/OracleRound.js');

const PEER_WAIT_MS = 8000;
const SETTLE_MS    = 6000;
const BLOCK_INDEX  = 100;
const BLOCK_TIME   = 1700000000;
const ROUND        = 100;
const PAIR         = 'BTC/USD';
const PRICE        = '60000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Attach a real OracleConsensus per hub (registers ORACLE_* P2P handlers); skip
// OracleRound.start() so no price-fetch cadence races our manual round.
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

// Inject the SAME submission set into every hub so each aggregates the identical
// canonical and the leader's proposal verifies on every follower.
function injectSubmissions(mvh) {
    const addrs = mvh.hubs.map((h) => h.getPeerManager().validatorAddr);
    for (const hub of mvh.hubs) {
        const subs = new Map();
        for (const addr of addrs) subs.set(addr, { prices: [{ coinPair: PAIR, price: PRICE }] });
        hub._wtRound.submissions.set(ROUND, subs);
    }
}

async function finalizeAll(mvh, settle) {
    await Promise.all(mvh.hubs.map((h) => h._wtOracle.finalizeRound(ROUND, BLOCK_INDEX, BLOCK_TIME).catch(() => {})));
    await sleep(settle || SETTLE_MS);
}

async function snapshotRows(hub) {
    return hub.db.doQuery(
        'SELECT * FROM price_snapshots WHERE round_number = ? AND coin_pair = ?',
        [ROUND, PAIR]);
}

// The deterministic round leader (every hub agrees: same validator set + round).
function findOracleLeader(mvh) {
    return mvh.hubs.find((h) => {
        const l = h._wtOracle._getLeader(ROUND);
        return l && l.addr === h.getPeerManager().validatorAddr;
    });
}

// Four EQUAL-weight sources → weighted quorum behaves as count-3.
function seedEqual(mvh) {
    const ids = mvh.identities;
    return seedWeightSnapshot(mvh, {
        blockIndex: BLOCK_INDEX,
        validators: [
            { pubkey: ids[0].pubkeyHex, source: 'sA', weight: '1000' },
            { pubkey: ids[1].pubkeyHex, source: 'sB', weight: '1000' },
            { pubkey: ids[2].pubkeyHex, source: 'sC', weight: '1000' },
            { pubkey: ids[3].pubkeyHex, source: 'sD', weight: '1000' },
        ],
    });
}

describe('MultiValidatorHub: oracle-PBFT byzantine fault tolerance (C.2)', function () {
    this.timeout(240_000);

    // LIVENESS: one silenced oracle validator does not stall the round
    describe('LIVENESS (f=1): a silent oracle validator does not stall finalization', function () {
        let db, mvh, seed, oracle, restore;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping oracle-byzantine liveness: no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: 4, basePort: 26200, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            seed   = seedEqual(mvh);
            oracle = await attachOracle(mvh);
            injectSubmissions(mvh);
        });

        after(async function () {
            if (restore) restore();
            if (oracle) oracle.stop();
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('the honest 3-of-4 finalize the correct median; the silenced hub stores nothing', async function () {
            const leader = findOracleLeader(mvh);
            assert.ok(leader, 'no oracle round leader identified');
            const victim = mvh.hubs.find((h) => h !== leader);   // silence a NON-leader
            restore = silenceOracleValidator(victim);

            await finalizeAll(mvh);

            const honest = mvh.hubs.filter((h) => h !== victim);
            const seen = [];
            for (const h of honest) {
                const rows = await snapshotRows(h);
                assert.strictEqual(rows.length, 1, 'an honest hub must finalize exactly one price snapshot (got ' + rows.length + ')');
                assert.strictEqual(String(rows[0].price), PRICE + '.00000000', 'honest hub stored an unexpected price (got ' + rows[0].price + ')');
                seen.push(String(rows[0].price));
            }
            assert.strictEqual(new Set(seen).size, 1, 'honest hubs must agree on the finalized price');

            const victimRows = await snapshotRows(victim);
            assert.strictEqual(victimRows.length, 0, 'the silenced hub must not have finalized (it processed no messages)');
        });
    });

    // SAFETY: two silenced validators → quorum unreachable → no finalization
    describe('SAFETY (2-of-4 down): quorum is unreachable, nothing finalizes', function () {
        let db, mvh, seed, oracle, restores = [];

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping oracle-byzantine safety: no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: 4, basePort: 26210, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            seed   = seedEqual(mvh);
            oracle = await attachOracle(mvh);
            injectSubmissions(mvh);
        });

        after(async function () {
            restores.forEach((r) => { try { r(); } catch (_) {} });
            if (oracle) oracle.stop();
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('with two oracle validators silenced, no price snapshot finalizes on any hub', async function () {
            const leader = findOracleLeader(mvh);
            assert.ok(leader, 'no oracle round leader identified');
            // Silence two NON-leaders → leader + 1 honest = 2 active < quorum 3.
            const nonLeaders = mvh.hubs.filter((h) => h !== leader);
            restores.push(silenceOracleValidator(nonLeaders[0]));
            restores.push(silenceOracleValidator(nonLeaders[1]));

            await finalizeAll(mvh);

            for (let i = 0; i < mvh.hubs.length; i++) {
                const rows = await snapshotRows(mvh.hubs[i]);
                assert.strictEqual(rows.length, 0,
                    'hub ' + i + ' finalized a price below quorum (got ' + rows.length + ' rows): safety violation');
            }
        });
    });
});
