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
 * L2 integration: STAKE_WEIGHTED_QUORUM (WI-1) R-1 degenerate-case uniformity
 * (Suite C of the regtest e2e plan).
 *
 * Spec §3.6 (R-1): the stake predicate 3·Σweight > 2·S makes BOTH degenerate
 * cases fall out with no per-engine special-casing, and WI-1 deletes the old
 * per-engine `N≤1 ? 0/1` count branches so every weighted engine decides
 * identically:
 *   - N=1 (single staker): finalizes on its OWN signature (the quorum===0 /
 *     snapCount<=1 single-node fast path; the sole staker is the whole snapshot).
 *   - S=0 (≥2 validators but zero total stake): 0 > 0 is false → NEVER finalizes
 *     (consensus disabled), uniformly.
 *
 * This drives THREE representative engines that route finalization through the
 * shared predicate: config-change PBFT (Consensus), price (OracleConsensus), and
 * checkpoints (StateCheckpointEngine, oracle_publish). These run over real hubs
 * and assert the SAME finalize/no-finalize decision from each at both degenerate
 * inputs. The cross-service predicate parity (hub bcmath == indexer mathjs over
 * 500 fixtures) and the cross_chain / attestation degenerate paths are covered by
 * the unit suites + Suites A2/A4; this is the live cross-ENGINE uniformity check.
 *
 * The S=0 fixture uses ≥2 validators with ALL-ZERO weights so getQuorum's count
 * fast-path (count≤1 → 0) does NOT pre-empt the weighted `0 > 0 → false`, i.e. it
 * genuinely exercises the zero-stake predicate, not the single-node shortcut.
 *
 * No chain; disposable Docker MariaDB; skips when neither an env DB nor Docker is
 * available. regtest activation = 0 (always weighted).
 *
 * Spec: claude/reports/2026-06-14_cross-chain-quorum-security-spec.md §3.6, §3.7,
 * §10.4; plan §C.
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
const APPLY_MS     = 4000;
const STALL_MS     = 6000;
const BLOCK_INDEX  = 100;       // 100 % 2 = 0 → live checkpoint leader in the S=0 (2-hub) case
const BLOCK_TIME   = 1700000000;
const ROUND        = 100;
const PAIR         = 'BTC/USD';
const PRICE        = '60000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TIP = {
    coin: 'BTC', network: 'regtest', block_index: 500, block_time: BLOCK_TIME,
    block_hash: 'c0'.repeat(32), ledger_hash: 'a1'.repeat(32),
    actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    // SPV Phase 2 (xchain-hub 08228c8): post-flag-day the checkpoint canonical
    // signs the indexer light-client roots and StateCheckpointEngine fails closed
    // without them; regtest's commitment flag-day is genesis, so the stubbed
    // indexer view must carry them or every _tick throws (0 checkpoint rows).
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};

// Attach a real OracleConsensus per hub (P2P handlers via start(); no price-fetch
// cadence) and stub the checkpoint engine's indexer view + cached network.
async function attachEngines(mvh) {
    const stops = [];
    for (const hub of mvh.hubs) {
        const round = new OracleRound(hub);
        const oc    = new OracleConsensus(hub, round);
        round.setConsensus(oc);
        oc.setValidatorSet(await hub._loadValidatorSet());
        await oc.start();
        hub._cOracle = oc;
        hub._cRound  = round;
        stops.push(() => oc.stop && oc.stop());

        const cps = hub.stateCheckpoints;
        cps.network       = 'regtest';
        cps.chains        = ['BTC'];
        cps.confirmations = 0;
        cps.indexers.BTC  = { url: 'http://stubbed', key: '' };
        cps._indexerCall  = async () => Object.assign({}, TIP);
    }
    return { stop() { stops.forEach((s) => { try { s(); } catch (_) {} }); } };
}

function injectSubmissions(mvh) {
    const subAddrs = mvh.hubs.length >= 2
        ? mvh.hubs.map((h) => h.getPeerManager().validatorAddr)
        : ['synthA', 'synthB'];   // N=1 still needs >= minSubmissions entries to aggregate
    for (const hub of mvh.hubs) {
        const subs = new Map();
        for (const a of subAddrs) subs.set(a, { prices: [{ coinPair: PAIR, price: PRICE }] });
        hub._cRound.submissions.set(ROUND, subs);
    }
}

const COIN = 'BTC', NET = 'regtest', MODULE = 'node';

async function driveConfig(mvh, value) {
    const config = { [COIN]: { [NET]: { [MODULE]: { GAS_PRICE: value } } } };
    // Any hub can drive: N=1 self-finalizes (quorum 0); ≥2 routes through a leader.
    const leader = mvh.hubs.find((h) => {
        const l = h.consensus._getLeader(h.consensus.seq + 1);
        return l && l.addr === h.consensus.peerManager.validatorAddr;
    }) || mvh.hubs[0];
    await leader.addParametersFromJson(config).catch(() => {});
}
async function configApplied(hub, value) {
    const cfg = await hub.db.getConfig(COIN, NET, MODULE);
    return !!(cfg && cfg.GAS_PRICE === value);
}

async function drivePrice(mvh) {
    await Promise.all(mvh.hubs.map((h) => h._cOracle.finalizeRound(ROUND, BLOCK_INDEX, BLOCK_TIME).catch(() => {})));
}
async function priceFinalized(hub) {
    const r = await hub.db.doQuery('SELECT * FROM price_snapshots WHERE round_number = ? AND coin_pair = ?', [ROUND, PAIR]);
    return r.length > 0;
}

async function driveCheckpoint(mvh) {
    await Promise.all(mvh.hubs.map((h) => h.stateCheckpoints._tick().catch(() => {})));
}
async function checkpointFinalized(hub) {
    const r = await hub.db.doQuery(
        'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ?',
        ['BTC', 'regtest', TIP.block_index]);
    return r.length > 0;
}

describe('MultiValidatorHub: STAKE_WEIGHTED_QUORUM R-1 degenerate uniformity (WI-1 Suite C, L2)', function () {
    this.timeout(300_000);

    describe('C1 (N=1): every engine finalizes on the single staker', function () {
        let db, mvh, seed, engines;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping C1: no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: 1, basePort: 33900, startCrossChain: true, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            const ids = mvh.identities;
            seed = seedWeightSnapshot(mvh, {
                blockIndex: BLOCK_INDEX,
                validators: [{ pubkey: ids[0].pubkeyHex, source: 'solo', weight: '5000' }],
            });
            engines = await attachEngines(mvh);
            injectSubmissions(mvh);
        });

        after(async function () {
            if (engines) engines.stop();
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('config, price, and checkpoint all finalize for the sole staker', async function () {
            const VALUE = '321';
            await driveConfig(mvh, VALUE);
            await drivePrice(mvh);
            await driveCheckpoint(mvh);
            await sleep(APPLY_MS);

            const hub = mvh.hubs[0];
            const decisions = {
                config:     await configApplied(hub, VALUE),
                price:      await priceFinalized(hub),
                checkpoint: await checkpointFinalized(hub),
            };
            for (const [engine, ok] of Object.entries(decisions))
                assert.strictEqual(ok, true, 'engine ' + engine + ' did NOT finalize at N=1 (expected single-staker finalize)');
        });
    });

    describe('C2 (S=0): no engine finalizes under zero total stake', function () {
        let db, mvh, seed, engines;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping C2: no env DB and Docker unavailable'); this.skip(); }
            // 2 validators so getQuorum's count fast-path (count≤1 → 0) does NOT fire;
            // ALL weights zero so S=0 and the weighted predicate 0>0 is false.
            mvh = new MultiValidatorHub({ count: 2, basePort: 34000, startCrossChain: true, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            const ids = mvh.identities;
            seed = seedWeightSnapshot(mvh, {
                blockIndex: BLOCK_INDEX,
                validators: [
                    { pubkey: ids[0].pubkeyHex, source: 'z0', weight: '0' },
                    { pubkey: ids[1].pubkeyHex, source: 'z1', weight: '0' },
                ],
            });
            engines = await attachEngines(mvh);
            injectSubmissions(mvh);
        });

        after(async function () {
            if (engines) engines.stop();
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('config, price, and checkpoint all REFUSE to finalize at S=0', async function () {
            const VALUE = '654';
            await driveConfig(mvh, VALUE);
            await drivePrice(mvh);
            await driveCheckpoint(mvh);
            await sleep(STALL_MS);

            for (let i = 0; i < mvh.hubs.length; i++) {
                const hub = mvh.hubs[i];
                assert.strictEqual(await configApplied(hub, VALUE), false,
                    'hub ' + i + ': config applied at S=0 (must be disabled)');
                assert.strictEqual(await priceFinalized(hub), false,
                    'hub ' + i + ': price finalized at S=0 (must be disabled)');
                assert.strictEqual(await checkpointFinalized(hub), false,
                    'hub ' + i + ': checkpoint finalized at S=0 (must be disabled)');
            }
        });
    });
});
