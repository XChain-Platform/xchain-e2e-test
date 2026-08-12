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
 * Track C.2: per-feature validator-scale at N=10 (the federated decision engines).
 *
 * The N=10 column already has config-PBFT (multiHubConsensusN10) and consensus +
 * capability staking. This suite fills the remaining IN-PROCESS-runnable per-feature
 * cells by driving the OTHER two PBFT engines at N=10 with a real weighted-stake
 * snapshot, proving the weighted multi-signer quorum (3·tally > 2·S) finalizes at
 * scale, not just at the N=3/4 floor the WI-1 weighted suites prove:
 *
 *   - OracleConsensus  (price_snapshots round)  -> covers the Price oracle AND
 *       Fiat oracle rows: a fiat pair is the SAME OracleConsensus round over a
 *       different coinPair, so one N=10 round proves both.
 *   - CrossChainDexConsensus, two surfaces over the same engine:
 *       * cross-chain DEX match  (cross_chain_matches finalize -> escrow release)
 *       * XCALL dispatch relay   (cross_chain_calls finalize)
 *
 * Weights are EQUAL (10 sources x 1000 = S=10000), so the weighted quorum
 * (tally > 2S/3 = 6666) needs >=7 distinct signers: every finalized round here
 * carries a genuine >=7-of-10 weighted multi-signer aggregate (3 slack, not the
 * zero-slack BFT floor). Attestation's weighted path is a pure N-agnostic
 * responsible-set ranking (REDUNDANCY=3 regardless of validator count) and is
 * already proven live at N=3, so it has no distinct N=10 federation behavior to add.
 *
 * Drivers are lifted from the green WI-1 weighted suites (multiHubOracleWeighted,
 * multiHubCrossChainDexWeighted, multiHubXcallWeighted), re-run at count=10. State
 * checkpoint + ANCHOR are chain-gated (need a live coin node) and out of scope here.
 *
 * Disposable Docker MariaDB; skips when neither an env DB nor Docker is available.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const crypto = require('crypto');
const { MultiValidatorHub, ValidatorIdentity, loadHubModule } = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../helpers/seededWeightSnapshot');
const { MockCrossChainOfferBook, makeOrder } = require('../helpers/mockCrossChainOfferBook');

const OracleConsensus = loadHubModule('src/OracleConsensus.js');
const OracleRound     = loadHubModule('src/OracleRound.js');

const COUNT        = 10;
const QUORUM_SIGS  = 7;          // tally > 2S/3 with equal weights => >=7 of 10 sources
const PEER_WAIT_MS = 12000;      // 10-node mesh (45 connections) needs time to form
const SETTLE_MS    = 9000;       // COMMIT propagation across 10 hubs
const BLOCK_INDEX  = 100;
const BLOCK_TIME   = 1700000000;
const NETWORK      = 'regtest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Equal-weight snapshot over the COUNT live hubs (S = COUNT*1000). No single
// source >= 2/3, so finalization requires a genuine >=7-source weighted quorum.
function equalWeights(mvh) {
    return mvh.identities.slice(0, COUNT).map((id, i) => ({
        pubkey: id.pubkeyHex, source: 's' + i, weight: '1000'
    }));
}

const ORACLE_ROUND = 100, PAIR = 'BTC/USD', PRICE = '60000';

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
        hub._wtRound.submissions.set(ORACLE_ROUND, subs);
    }
}

function callIdFrom(seed) { return crypto.createHash('sha256').update(String(seed)).digest('hex'); }

function dispatchRow(roundId, callId) {
    return {
        round_id: roundId, call_id: callId, phase: 'dispatch', snapshot_block: BLOCK_INDEX,
        network: NETWORK, source_chain: 'DOGE', source_action_index: 5, source_contract_index: 1,
        target_chain: 'LTC', target_contract_index: 2, method: 'ping', params_json: '[]',
        gas_limit: 100000, cross_hops: 0, effective_time: 1700000000,
        result_status: null, return_payload_b64: null
    };
}

async function driveDispatch(mvh, validators, seedBase) {
    const engines = mvh.hubs.map((h) => h.crossChainCalls);
    engines.forEach((e) => { e.validateProposedMatch = async () => true; });
    const callId  = callIdFrom(seedBase);
    const roundId = engines[0]._roundId('dispatch', callId);
    const row = dispatchRow(roundId, callId);
    const events = [];
    const listeners = engines.map((e, i) => { const fn = (ev) => events.push(Object.assign({ hubIndex: i }, ev)); e.consensus.on('match:finalized', fn); return fn; });
    await Promise.all(engines.map((e) => e.consensus.propose(roundId, { row, snapshot: { validators, count: validators.length } }).catch(() => {})));
    await sleep(SETTLE_MS);
    engines.forEach((e, i) => e.consensus.removeListener('match:finalized', listeners[i]));
    return { events, row };
}

function crossingPair({ ltcIdx, dogeIdx, amount = '40' }) {
    return {
        LTC:  [ makeOrder({ action_index: ltcIdx,  give: { coin: 'LTC',  tick: 'TOKA', amount },
                            get: { coin: 'DOGE', tick: 'TOKB', amount }, get_address: 'addr_ltc_' + ltcIdx, block_index: BLOCK_INDEX }) ],
        DOGE: [ makeOrder({ action_index: dogeIdx, give: { coin: 'DOGE', tick: 'TOKB', amount },
                            get: { coin: 'LTC',  tick: 'TOKA', amount }, get_address: 'addr_doge_' + dogeIdx, block_index: BLOCK_INDEX }) ]
    };
}

async function driveDexRound(mvh) {
    const dexes = mvh.getCrossChainDexes();
    const events = [];
    const listeners = dexes.map((d, i) => { const fn = (ev) => events.push(Object.assign({ hubIndex: i }, ev)); d.consensus.on('match:finalized', fn); return fn; });
    await Promise.all(dexes.map((d) => d._discoverAndMatch().catch(() => {})));
    await sleep(SETTLE_MS);
    dexes.forEach((d, i) => d.consensus.removeListener('match:finalized', listeners[i]));
    return events;
}

function countVerifyingSigs(canonical, signatures) {
    const ok = new Set();
    for (const s of (signatures || []))
        if (ValidatorIdentity.verify(canonical, String(s.sig || ''), String(s.pubkey || '').toLowerCase()))
            ok.add(String(s.pubkey || '').toLowerCase());
    return ok.size;
}

describe('MultiValidatorHub: per-feature weighted quorum at N=10 (C.2)', function () {
    this.timeout(360_000);

    before(function () {
        // 10 hubs share 127.0.0.1; raise the per-IP inbound cap so the 9-peer mesh forms.
        process.env.P2P_MAX_CONNECTIONS_PER_IP = '50';
    });

    describe('Price + Fiat oracle round (OracleConsensus) finalizes at N=10', function () {
        let db, mvh, seed, oracle;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping oracle N=10: no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: COUNT, basePort: 25000, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            seed   = seedWeightSnapshot(mvh, { blockIndex: BLOCK_INDEX, validators: equalWeights(mvh) });
            oracle = await attachOracle(mvh);
            injectSubmissions(mvh);
        });

        after(async function () {
            if (oracle) oracle.stop();
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('the weighted quorum (>=7 of 10) finalizes the identical price snapshot on EVERY hub', async function () {
            await Promise.all(mvh.hubs.map((h) => h._wtOracle.finalizeRound(ORACLE_ROUND, BLOCK_INDEX, BLOCK_TIME).catch(() => {})));
            await sleep(SETTLE_MS);
            const seen = [];
            for (let i = 0; i < mvh.hubs.length; i++) {
                const rows = await mvh.hubs[i].db.doQuery(
                    'SELECT * FROM price_snapshots WHERE round_number = ? AND coin_pair = ?', [ORACLE_ROUND, PAIR]);
                assert.strictEqual(rows.length, 1, 'hub ' + i + ' must hold exactly one finalized snapshot (got ' + rows.length + ')');
                assert.strictEqual(String(rows[0].price), PRICE + '.00000000', 'hub ' + i + ' stored an unexpected price');
                assert.ok(Number(rows[0].validator_count) >= QUORUM_SIGS,
                    'hub ' + i + ' expected >= ' + QUORUM_SIGS + ' weighted signers at N=10, got ' + rows[0].validator_count);
                seen.push(String(rows[0].price));
            }
            assert.strictEqual(new Set(seen).size, 1, 'all hubs must agree on the finalized price');
        });
    });

    describe('Cross-chain DEX match (CrossChainDexConsensus) finalizes at N=10', function () {
        let db, mvh, seed, book;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping cross-chain DEX N=10: no env DB and Docker unavailable'); this.skip(); }
            book = new MockCrossChainOfferBook();
            await book.start();
            book.setBook('shared', { network: NETWORK, latestBlockIndex: 200, ordersByCoin: crossingPair({ ltcIdx: 11, dogeIdx: 21 }) });
            mvh = new MultiValidatorHub({
                count: COUNT, basePort: 25100, startCrossChain: true, startAttestation: false,
                crossChainIndexerUrls: { LTC: book.urlFor('shared', 'LTC'), DOGE: book.urlFor('shared', 'DOGE') }
            });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            seed = seedWeightSnapshot(mvh, { blockIndex: BLOCK_INDEX, validators: equalWeights(mvh) });
        });

        after(async function () {
            if (seed) seed.restore();
            if (book) await book.stop();
            if (mvh)  { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)   { await db.stop(); }
        });

        it('the weighted quorum (>=7 of 10) finalizes the identical match on EVERY hub', async function () {
            const events = await driveDexRound(mvh);
            assert.strictEqual(events.length, COUNT, 'expected all ' + COUNT + ' hubs to finalize, got ' + events.length);
            const matchIds = new Set(events.map((e) => e.matchId));
            assert.strictEqual(matchIds.size, 1, 'hubs finalized different match_ids: ' + JSON.stringify([...matchIds]));

            const dexes = mvh.getCrossChainDexes();
            for (const ev of events) {
                const n = countVerifyingSigs(dexes[ev.hubIndex]._canonicalMatch(ev.row), ev.signatures);
                assert.ok(n >= QUORUM_SIGS, 'hub ' + ev.hubIndex + ' finalized with < ' + QUORUM_SIGS + ' distinct verifying sigs (' + n + ')');
            }
            const matchId = [...matchIds][0];
            for (let i = 0; i < mvh.hubs.length; i++) {
                const rows = await mvh.hubs[i].db.doQuery(
                    'SELECT status, validator_signatures FROM cross_chain_matches WHERE match_id = ?', [matchId]);
                assert.strictEqual(rows.length, 1, 'hub ' + i + ' has no cross_chain_matches row');
                assert.strictEqual(rows[0].status, 'finalized', 'hub ' + i + ' row not finalized');
                assert.ok(JSON.parse(rows[0].validator_signatures || '[]').length >= QUORUM_SIGS, 'hub ' + i + ' persisted < ' + QUORUM_SIGS + ' sigs');
            }
        });
    });

    describe('XCALL dispatch relay (CrossChainDexConsensus) finalizes at N=10', function () {
        let db, mvh, seed, validators;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping XCALL N=10: no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: COUNT, basePort: 25200, startCrossChain: true, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            validators = equalWeights(mvh);
            seed = seedWeightSnapshot(mvh, { blockIndex: BLOCK_INDEX, validators });
        });

        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('the weighted quorum (>=7 of 10) finalizes the dispatch on EVERY hub', async function () {
            const { events, row } = await driveDispatch(mvh, validators, 'xcall-n10-pos');
            assert.strictEqual(events.length, COUNT, 'expected all ' + COUNT + ' hubs to finalize, got ' + events.length);
            const callIds = new Set(events.map((e) => String(e.row && e.row.call_id)));
            assert.strictEqual(callIds.size, 1, 'hubs finalized different call_ids: ' + JSON.stringify([...callIds]));

            const engines = mvh.hubs.map((h) => h.crossChainCalls);
            for (const ev of events) {
                const n = countVerifyingSigs(engines[ev.hubIndex]._canonicalMatch(ev.row), ev.signatures);
                assert.ok(n >= QUORUM_SIGS, 'hub ' + ev.hubIndex + ' finalized with < ' + QUORUM_SIGS + ' distinct verifying sigs (' + n + ')');
            }
            for (let i = 0; i < mvh.hubs.length; i++) {
                const rows = await mvh.hubs[i].db.doQuery(
                    "SELECT validator_signatures FROM cross_chain_calls WHERE call_id = ? AND phase = 'dispatch'", [row.call_id]);
                assert.strictEqual(rows.length, 1, 'hub ' + i + ' has no finalized dispatch row');
                assert.ok(JSON.parse(rows[0].validator_signatures || '[]').length >= QUORUM_SIGS, 'hub ' + i + ' persisted < ' + QUORUM_SIGS + ' sigs');
            }
        });
    });
});
