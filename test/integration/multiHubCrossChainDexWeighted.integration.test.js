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
 * L2 integration — STAKE_WEIGHTED_QUORUM (WI-1) for the cross_chain capability:
 * cross-chain DEX match finalization (Suite A4 of the regtest e2e plan).
 *
 * The weighted twin of multiHubCrossChainDex.integration.test.js — the actual
 * ledger-binding path (a finalized cross_chain_matches row is what releases
 * escrow). Drives the REAL CrossChainDexConsensus PBFT match round
 * (XDEX_MATCH_PROPOSE → PREPARE → COMMIT) over live P2P with a SOURCE-keyed weight
 * snapshot, proving the WI-1 thesis for cross_chain:
 *
 *   - NEGATIVE: 3 live small-stake hubs (a COUNT majority) hold only 3000/10000
 *     stake; a whale source sits in the snapshot (counts toward S) but is OFFLINE.
 *     The 3 live hubs sign the match, the weighted tally (3·3000 !> 2·10000)
 *     refuses → NO match finalizes on any hub → no settleable cross_chain_matches
 *     row. The exact forged-settlement the old count rule would have released.
 *   - POSITIVE: 4 live hubs with uneven weights (4000/3000/2000/1000, no single
 *     source ≥ 2/3) → multi-signer weighted quorum → the identical finalized match
 *     lands on every hub.
 *
 * The DEX engine gates weighting on the MATCH's network (row.network='regtest' from
 * the offer book) and passes network explicitly to the weighted check — no
 * cached-network gotcha. seedWeightSnapshot stubs getWeightSnapshot; the leader is
 * chosen over the live (registered) pubkeys, so the offline whale can't lead.
 *
 * Shared in-memory offer book (no indexer, no chain); disposable Docker MariaDB;
 * skips when neither an env DB nor Docker is available. regtest activation = 0.
 *
 * Spec: claude/reports/2026-06-14_cross-chain-quorum-security-spec.md §1, §3.7,
 * §10; plan §A4.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub, ValidatorIdentity } = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../helpers/seededWeightSnapshot');
const { MockCrossChainOfferBook, makeOrder } = require('../helpers/mockCrossChainOfferBook');

const PEER_WAIT_MS = 8000;
const SETTLE_MS    = 6000;
const BLOCK_INDEX  = 100;
const NETWORK      = 'regtest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A crossing LTC⇄DOGE ORDER pair (1:1 price → always crosses).
function crossingPair({ ltcIdx, dogeIdx, ltcGive = '90', dogeGive = '40' }) {
    return {
        LTC: [ makeOrder({
            action_index: ltcIdx,
            give: { coin: 'LTC',  tick: 'TOKA', amount: ltcGive },
            get:  { coin: 'DOGE', tick: 'TOKB', amount: ltcGive },
            get_address: 'addr_ltc_order_' + ltcIdx + '_on_doge',
            block_index: BLOCK_INDEX
        }) ],
        DOGE: [ makeOrder({
            action_index: dogeIdx,
            give: { coin: 'DOGE', tick: 'TOKB', amount: dogeGive },
            get:  { coin: 'LTC',  tick: 'TOKA', amount: dogeGive },
            get_address: 'addr_doge_order_' + dogeIdx + '_on_ltc',
            block_index: BLOCK_INDEX
        }) ]
    };
}

async function driveRound(mvh, settleMs = SETTLE_MS) {
    const dexes = mvh.getCrossChainDexes();
    const events = [];
    const listeners = dexes.map((d, i) => {
        const fn = (ev) => events.push(Object.assign({ hubIndex: i }, ev));
        d.consensus.on('match:finalized', fn);
        return fn;
    });
    await Promise.all(dexes.map((d) => d._discoverAndMatch().catch(() => {})));
    await sleep(settleMs);
    dexes.forEach((d, i) => d.consensus.removeListener('match:finalized', listeners[i]));
    return events;
}

describe('MultiValidatorHub — STAKE_WEIGHTED_QUORUM cross-chain DEX match (WI-1 Suite A4, L2)', function () {
    this.timeout(240_000);

    // ── NEGATIVE: count-majority / stake-minority of live hubs cannot settle ──
    describe('a stake-minority (count-majority) of live hubs cannot finalize a match', function () {
        let db, mvh, seed, book;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping A4 (negative) — no env DB and Docker unavailable'); this.skip(); }
            book = new MockCrossChainOfferBook();
            await book.start();
            book.setBook('shared', { network: NETWORK, latestBlockIndex: 200,
                                     ordersByCoin: crossingPair({ ltcIdx: 10, dogeIdx: 20 }) });
            mvh = new MultiValidatorHub({
                count: 3, basePort: 33700, startCrossChain: true, startAttestation: false,
                crossChainIndexerUrls: { LTC: book.urlFor('shared', 'LTC'), DOGE: book.urlFor('shared', 'DOGE') }
            });
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
            // S = 10000; the 3 live signers hold 3000.
        });

        after(async function () {
            if (seed) seed.restore();
            if (book) await book.stop();
            if (mvh)  { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)   { await db.stop(); }
        });

        it('no match finalizes and no settleable row is written on any hub', async function () {
            const events = await driveRound(mvh);
            assert.strictEqual(events.length, 0,
                'a match finalized despite a STAKE minority of live signers: ' +
                JSON.stringify(events.map((e) => ({ hub: e.hubIndex, sigs: (e.signatures || []).length }))));
            for (let i = 0; i < mvh.hubs.length; i++) {
                const rows = await mvh.hubs[i].db.doQuery(
                    "SELECT match_id FROM cross_chain_matches WHERE status = 'finalized'");
                assert.strictEqual(rows.length, 0, 'hub ' + i + ' wrote a finalized match a stake minority must never settle');
            }
        });
    });

    // ── POSITIVE: a healthy weighted federation finalizes the match ──
    describe('a healthy weighted federation finalizes the match on every hub', function () {
        let db, mvh, seed, book;

        before(async function () {
            db = await startDisposableHubDb();
            if (!db) { console.log('Skipping A4 (positive) — no env DB and Docker unavailable'); this.skip(); }
            book = new MockCrossChainOfferBook();
            await book.start();
            book.setBook('shared', { network: NETWORK, latestBlockIndex: 200,
                                     ordersByCoin: crossingPair({ ltcIdx: 11, dogeIdx: 21 }) });
            mvh = new MultiValidatorHub({
                count: 4, basePort: 33800, startCrossChain: true, startAttestation: false,
                crossChainIndexerUrls: { LTC: book.urlFor('shared', 'LTC'), DOGE: book.urlFor('shared', 'DOGE') }
            });
            await mvh.start();
            await sleep(PEER_WAIT_MS);
            const ids = mvh.identities;
            // Uneven weights, no single source ≥ 2/3 (S=10000) → multi-signer quorum.
            seed = seedWeightSnapshot(mvh, {
                blockIndex: BLOCK_INDEX,
                validators: [
                    { pubkey: ids[0].pubkeyHex, source: 'sA', weight: '4000' },
                    { pubkey: ids[1].pubkeyHex, source: 'sB', weight: '3000' },
                    { pubkey: ids[2].pubkeyHex, source: 'sC', weight: '2000' },
                    { pubkey: ids[3].pubkeyHex, source: 'sD', weight: '1000' },
                ],
            });
        });

        after(async function () {
            if (seed) seed.restore();
            if (book) await book.stop();
            if (mvh)  { await mvh.stop(); await mvh.dropDatabases(); }
            if (db)   { await db.stop(); }
        });

        it('the weighted quorum is reached — the identical match finalizes on EVERY hub', async function () {
            const events = await driveRound(mvh);
            assert.strictEqual(events.length, 4, 'expected all 4 hubs to finalize, got ' + events.length);
            const matchIds = new Set(events.map((e) => e.matchId));
            assert.strictEqual(matchIds.size, 1, 'hubs finalized different match_ids: ' + JSON.stringify([...matchIds]));

            // Each finalize carries ≥2 DISTINCT verifying sigs (no single source ≥2/3),
            // and persists a finalized row on every hub.
            const dexes = mvh.getCrossChainDexes();
            for (const ev of events) {
                const canonical = dexes[ev.hubIndex]._canonicalMatch(ev.row);
                const ok = new Set();
                for (const s of (ev.signatures || []))
                    if (ValidatorIdentity.verify(canonical, String(s.sig || ''), String(s.pubkey || '').toLowerCase()))
                        ok.add(String(s.pubkey || '').toLowerCase());
                assert.ok(ok.size >= 2, 'hub ' + ev.hubIndex + ' finalized with < 2 distinct verifying sigs (' + ok.size + ')');
            }
            const matchId = [...matchIds][0];
            for (let i = 0; i < mvh.hubs.length; i++) {
                const rows = await mvh.hubs[i].db.doQuery(
                    'SELECT status, validator_signatures FROM cross_chain_matches WHERE match_id = ?', [matchId]);
                assert.strictEqual(rows.length, 1, 'hub ' + i + ' has no cross_chain_matches row');
                assert.strictEqual(rows[0].status, 'finalized', 'hub ' + i + ' row not finalized');
                assert.ok(JSON.parse(rows[0].validator_signatures || '[]').length >= 2, 'hub ' + i + ' persisted < 2 sigs');
            }
        });
    });
});
