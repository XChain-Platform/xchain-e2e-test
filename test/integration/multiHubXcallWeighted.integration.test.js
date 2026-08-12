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
 * Track C.2: STAKE_WEIGHTED_QUORUM for XCALL relay dispatch (cross_chain).
 *
 * XCALL result-delivery quorum was unit-tested (stubbed) but never driven through
 * a real in-process federation. This is the XCALL twin of the cross-chain DEX
 * weighted suite (A4): the CrossChainCallEngine relays a dispatch row through the
 * SAME CrossChainDexConsensus PBFT (XCALL_RELAY_PROPOSE → PREPARE → COMMIT), and
 * the weighted quorum gates whether a cross_chain_calls row finalizes:
 *   - NEGATIVE: 3 live small-stake hubs (count majority) + an offline whale source
 *     in the snapshot → weighted tally (3·1000 !> 2·10000) refuses → NO row;
 *   - POSITIVE: 4 live uneven-weight hubs (no source >= 2/3) → multi-signer weighted
 *     quorum → the dispatch row finalizes on every hub with >=2 distinct sigs.
 *
 * There is no offer book / discovery for XCALL, so the round is driven by calling
 * consensus.propose directly on the deterministic round leader with a hand-built
 * dispatch row (every canonical field populated). Followers' validateProposedMatch
 * re-verifies against the source-chain indexer via _indexerCall, which is
 * unavailable in-process, so it is overridden to accept (that path is covered by
 * CrossChainCallEngine.test.js); the quorum/signature aggregation under test is
 * unaffected. regtest activates weighting at height 0.
 *
 * Disposable Docker MariaDB; skips when neither an env DB nor Docker is available.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const crypto = require('crypto');
const { MultiValidatorHub, ValidatorIdentity } = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../helpers/seededWeightSnapshot');

const PEER_WAIT_MS = 8000;
const SETTLE_MS    = 6000;
const BLOCK_INDEX  = 100;
const NETWORK      = 'regtest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function callIdFrom(seed) { return crypto.createHash('sha256').update(String(seed)).digest('hex'); }

function dispatchRow(roundId, callId) {
    return {
        round_id:              roundId,
        call_id:               callId,
        phase:                 'dispatch',
        snapshot_block:        BLOCK_INDEX,
        network:               NETWORK,
        source_chain:          'DOGE',
        source_action_index:   5,
        source_contract_index: 1,
        target_chain:          'LTC',
        target_contract_index: 2,
        method:                'ping',
        params_json:           '[]',
        gas_limit:             100000,
        cross_hops:            0,
        effective_time:        1700000000,
        result_status:         null,
        return_payload_b64:    null
    };
}

// Drive ONE dispatch round: override validateProposedMatch on every hub, pick the
// callId/leader, propose on the leader, collect finalize events. `requireLiveLeader`
// searches callIds until the deterministic leader is a live (registered) hub.
// This is needed for the negative case so the refusal is a genuine stake-minority
// refusal, not leader-absence.
async function driveDispatch(mvh, validators, seedBase, requireLiveLeader) {
    const engines = mvh.hubs.map((h) => h.crossChainCalls);
    engines.forEach((e) => { e.validateProposedMatch = async () => true; });
    const livePubkeys = mvh.getPubkeys().map((p) => p.toLowerCase());

    let callId, roundId, leaderPubkey, leaderIdx, n = 0;
    do {
        callId = callIdFrom(seedBase + ':' + n);
        roundId = engines[0]._roundId('dispatch', callId);
        leaderPubkey = engines[0].consensus._leaderFor(roundId.toLowerCase(), validators, 0);
        leaderIdx = livePubkeys.findIndex((pk) => pk === String(leaderPubkey).toLowerCase());
        n++;
    } while (requireLiveLeader && leaderIdx < 0 && n < 64);

    const row = dispatchRow(roundId, callId);
    const events = [];
    const listeners = engines.map((e, i) => { const fn = (ev) => events.push(Object.assign({ hubIndex: i }, ev)); e.consensus.on('match:finalized', fn); return fn; });
    // Every hub runs the round (mirrors _discoverAndMatch on all DEX engines):
    // each creates its pending context, the deterministic leader broadcasts
    // PROPOSE, and followers validate + sign. The row is identical across hubs so
    // every canonical matches.
    await Promise.all(engines.map((e) => e.consensus.propose(roundId, { row, snapshot: { validators, count: validators.length } }).catch(() => {})));
    await sleep(SETTLE_MS);
    engines.forEach((e, i) => e.consensus.removeListener('match:finalized', listeners[i]));
    return { events, callId, leaderIdx, row };
}

describe('MultiValidatorHub: STAKE_WEIGHTED_QUORUM XCALL dispatch relay (C.2)', function () {
    this.timeout(240_000);

    describe('a stake-minority (count-majority) of live hubs cannot finalize an XCALL dispatch', function () {
        let db, mvh, seed, validators;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping XCALL weighted (negative): no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: 3, basePort: 26400, startCrossChain: true, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            const ids = mvh.identities;
            validators = [
                { pubkey: ids[0].pubkeyHex, source: 'sA',    weight: '1000' },
                { pubkey: ids[1].pubkeyHex, source: 'sB',    weight: '1000' },
                { pubkey: ids[2].pubkeyHex, source: 'sC',    weight: '1000' },
                { pubkey: 'ff'.repeat(32),  source: 'whale', weight: '7000' },   // offline
            ];
            seed = seedWeightSnapshot(mvh, { blockIndex: BLOCK_INDEX, validators });
        });

        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('no dispatch row finalizes on any hub (stake minority refused)', async function () {
            const { events, leaderIdx } = await driveDispatch(mvh, validators, 'xcall-neg', true);
            assert.ok(leaderIdx >= 0, 'could not place the round leader on a live hub');
            assert.strictEqual(events.length, 0,
                'a dispatch finalized despite a STAKE minority of live signers: ' +
                JSON.stringify(events.map((e) => ({ hub: e.hubIndex, sigs: (e.signatures || []).length }))));
            for (let i = 0; i < mvh.hubs.length; i++) {
                const rows = await mvh.hubs[i].db.doQuery("SELECT call_id FROM cross_chain_calls WHERE phase = 'dispatch'");
                assert.strictEqual(rows.length, 0, 'hub ' + i + ' wrote a dispatch row a stake minority must never finalize');
            }
        });
    });

    describe('a healthy weighted federation finalizes the XCALL dispatch on every hub', function () {
        let db, mvh, seed, validators;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping XCALL weighted (positive): no env DB and Docker unavailable'); this.skip(); }
            mvh = new MultiValidatorHub({ count: 4, basePort: 26410, startCrossChain: true, startAttestation: false });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            const ids = mvh.identities;
            // Uneven weights, no single source >= 2/3 of S=10000 → multi-signer quorum.
            validators = [
                { pubkey: ids[0].pubkeyHex, source: 'sA', weight: '4000' },
                { pubkey: ids[1].pubkeyHex, source: 'sB', weight: '3000' },
                { pubkey: ids[2].pubkeyHex, source: 'sC', weight: '2000' },
                { pubkey: ids[3].pubkeyHex, source: 'sD', weight: '1000' },
            ];
            seed = seedWeightSnapshot(mvh, { blockIndex: BLOCK_INDEX, validators });
        });

        after(async function () {
            if (seed) seed.restore();
            if (mvh) { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)  { await db.stop(); }
        });

        it('the weighted quorum is reached: the dispatch finalizes on EVERY hub with >=2 distinct sigs', async function () {
            const { events, row } = await driveDispatch(mvh, validators, 'xcall-pos', false);
            assert.strictEqual(events.length, 4, 'expected all 4 hubs to finalize, got ' + events.length);
            const callIds = new Set(events.map((e) => String(e.row && e.row.call_id)));
            assert.strictEqual(callIds.size, 1, 'hubs finalized different call_ids: ' + JSON.stringify([...callIds]));

            const engines = mvh.hubs.map((h) => h.crossChainCalls);
            for (const ev of events) {
                const canonical = engines[ev.hubIndex]._canonicalMatch(ev.row);
                const ok = new Set();
                for (const s of (ev.signatures || []))
                    if (ValidatorIdentity.verify(canonical, String(s.sig || ''), String(s.pubkey || '').toLowerCase()))
                        ok.add(String(s.pubkey || '').toLowerCase());
                assert.ok(ok.size >= 2, 'hub ' + ev.hubIndex + ' finalized with < 2 distinct verifying sigs (' + ok.size + ')');
            }

            for (let i = 0; i < mvh.hubs.length; i++) {
                const rows = await mvh.hubs[i].db.doQuery(
                    "SELECT validator_signatures FROM cross_chain_calls WHERE call_id = ? AND phase = 'dispatch'", [row.call_id]);
                assert.strictEqual(rows.length, 1, 'hub ' + i + ' has no finalized dispatch row');
                assert.ok(JSON.parse(rows[0].validator_signatures || '[]').length >= 2, 'hub ' + i + ' persisted < 2 sigs');
            }
        });
    });
});
