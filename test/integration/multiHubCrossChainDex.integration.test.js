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
 * L2 integration — cross-chain DEX match finalization across a real
 * multi-validator hub federation.
 *
 * Boots N=4 in-process XChainHub validators (MultiValidatorHub, real PeerManager
 * WebSocket P2P) with the cross-chain DEX engine started, and drives the REAL
 * PBFT match path (CrossChainDexConsensus: XDEX_MATCH_PROPOSE → PREPARE → COMMIT)
 * end to end over live transport. A shared in-memory offer book (no indexer, no
 * chain) feeds each engine an identical LTC⇄DOGE ORDER pair; every hub
 * independently re-derives the canonical and signs it.
 *
 * This is the federation counterpart to CrossChainDexConsensus.test.js (which
 * proves the algorithm over a MOCK bus) — here the same round runs over real
 * hubs, closing the single-validator gap (every prior live proof finalized with
 * `1 sig`). Asserts:
 *   - a match finalizes on every hub with >= 2f+1 = 3 DISTINCT, verifying sigs;
 *   - a divergent-book (byzantine) validator's signature is excluded, yet the
 *     honest majority still finalizes;
 *   - with 2 of 4 faulty, quorum is unreachable and NOTHING finalizes (safety).
 *
 * Quorum forces N=4: 2·⌊3/3⌋+1 = 3 (tolerates 1 fault); N=3 → quorum 1 (degenerate).
 *
 * Runs on a disposable Docker MariaDB (no platform-DB grant needed) — skips
 * cleanly only when neither an env-provisioned DB nor Docker is available.
 *
 * NOTE: the harness resolves xchain-hub via the first of several candidate paths
 * (multiValidatorHubHelper._loadHubModule). On a fresh checkout the monorepo
 * sibling resolves correctly, but if a STALE bundled copy exists at
 * xchain-e2e-test/xchain-hub/ (a gitignored e2e build artifact) it shadows the
 * monorepo source — set XCHAIN_HUB_PATH=<repo>/xchain-hub to force the live hub.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const { MultiValidatorHub, ValidatorIdentity } = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedStakeSnapshot }    = require('../helpers/seededStakeSnapshot');
const { silenceDexValidator }  = require('../helpers/byzantineFaults');
const { MockCrossChainOfferBook, makeOrder } = require('../helpers/mockCrossChainOfferBook');

const COUNT         = 4;       // quorum 3 — a real BFT majority tolerating 1 fault
const PEER_WAIT_MS  = 8000;    // mesh forms before we drive a round
const SETTLE_MS     = 6000;    // PBFT PROPOSE→PREPARE→COMMIT propagation window
const BLOCK_INDEX   = 100;     // seeded BTC-anchor block (snapshot_block)
const NETWORK       = 'regtest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A crossing LTC⇄DOGE ORDER pair: an LTC order giving `ltcGive` TOKA for TOKB, and
// a DOGE order giving `dogeGive` TOKB for TOKA (1:1 price, so it always crosses).
// Distinct action indices per test keep each match independent (the committed
// ledger + finalized-set are per-offer, so reusing indices would exhaust an offer).
function crossingPair({ ltcIdx, dogeIdx, ltcGive = '90', dogeGive = '40' }){
    return {
        LTC: [ makeOrder({
            action_index: ltcIdx,
            give: { coin: 'LTC',  tick: 'TOKA', amount: ltcGive },
            get:  { coin: 'DOGE', tick: 'TOKB', amount: ltcGive },   // 1:1
            get_address: 'addr_ltc_order_' + ltcIdx + '_on_doge',
            block_index: BLOCK_INDEX
        }) ],
        DOGE: [ makeOrder({
            action_index: dogeIdx,
            give: { coin: 'DOGE', tick: 'TOKB', amount: dogeGive },
            get:  { coin: 'LTC',  tick: 'TOKA', amount: dogeGive },  // 1:1
            get_address: 'addr_doge_order_' + dogeIdx + '_on_ltc',
            block_index: BLOCK_INDEX
        }) ]
    };
}

describe('MultiValidatorHub — cross-chain DEX match PBFT (L2)', function () {
    this.timeout(180_000);

    let db, mvh, seed, book;

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) {
            console.log('Skipping cross-chain DEX federation L2 — no env DB and Docker unavailable');
            this.skip();
        }

        // Offer-book mock first, so its URLs exist when the hubs' DEX engines start.
        book = new MockCrossChainOfferBook();
        await book.start();

        mvh = new MultiValidatorHub({
            count:           COUNT,
            basePort:        32000,
            startCrossChain: true,
            startAttestation: false,                  // DEX-focused — skip attestation cost
            crossChainIndexerUrls: {
                LTC:  book.urlFor('shared', 'LTC'),
                DOGE: book.urlFor('shared', 'DOGE')
            }
        });
        await mvh.start();
        await sleep(PEER_WAIT_MS);                     // mesh forms before we propose

        // Deterministic cross_chain validator set + BTC block, so every hub resolves
        // the same quorum 3 with no indexer / chain behind it.
        seed = seedStakeSnapshot(mvh, { blockIndex: BLOCK_INDEX });
    });

    after(async function () {
        if (seed) seed.restore();
        if (book) await book.stop();
        if (mvh)  { await mvh.stop(); await mvh.dropDatabases(); }
        if (db)   { await db.stop(); }
    });

    // Attach finalize listeners to every hub's DEX consensus, trigger one discovery
    // round on every engine (leader PROPOSEs, followers validate+sign), wait for
    // PBFT to settle over P2P, return the collected finalize events.
    async function driveRound(settleMs = SETTLE_MS){
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

    // Distinct verifying signatures over a finalize event's canonical match.
    function verifyingPubkeys(ev){
        const dex = mvh.getCrossChainDexes()[ev.hubIndex];
        const canonical = dex._canonicalMatch(ev.row);
        const ok = new Set();
        for (const s of (ev.signatures || [])) {
            const pk = String(s.pubkey || '').toLowerCase();
            if (ValidatorIdentity.verify(canonical, String(s.sig || ''), pk)) ok.add(pk);
        }
        return ok;
    }

    it('hubs are peer-connected and the DEX engine is active on every node', function () {
        for (const h of mvh.hubs) {
            assert.ok(h.getCrossChainDex(), 'cross-chain DEX engine not started');
            assert.ok(h.getCrossChainDex().consensus, 'DEX consensus not wired');
            const peers = h.peerManager ? h.peerManager.peers.size : 0;
            assert.strictEqual(peers, COUNT - 1, 'expected ' + (COUNT - 1) + ' peers, got ' + peers);
        }
    });

    it('every hub independently resolves the SAME, fault-tolerant quorum (3 for N=4)', function () {
        const quorums = mvh.hubs.map((h) => h.capabilitySnapshot.getQuorum(seed.snapshot));
        assert.ok(quorums.every((q) => q === quorums[0]), 'hubs disagree on quorum: ' + JSON.stringify(quorums));
        assert.strictEqual(quorums[0], 3, 'expected quorum 3 for N=4, got ' + quorums[0]);
    });

    it('a cross-chain ORDER match finalizes on EVERY hub with >= 3 distinct verifying sigs', async function () {
        book.setBook('shared', {
            network: NETWORK, latestBlockIndex: 200,
            ordersByCoin: crossingPair({ ltcIdx: 10, dogeIdx: 20 })
        });

        const events = await driveRound();

        // Every hub finalized the SAME match.
        assert.strictEqual(events.length, COUNT,
            'expected all ' + COUNT + ' hubs to finalize, got ' + events.length);
        const matchIds = new Set(events.map((e) => e.matchId));
        assert.strictEqual(matchIds.size, 1, 'hubs finalized different match_ids: ' + JSON.stringify([...matchIds]));

        // The core anti-regression vs the single-validator proof (`1 sig`): >= 2f+1
        // DISTINCT validator signatures, each verifying against the canonical.
        for (const ev of events) {
            const ok = verifyingPubkeys(ev);
            assert.ok(ok.size >= 3,
                'hub ' + ev.hubIndex + ' finalized with only ' + ok.size + ' verifying sigs (need >= 3)');
            assert.ok(ok.size >= 2, 'multi-validator signing did not occur (would be the old 1-sig path)');
        }

        // Persisted to EVERY hub's own DB with the multi-sig bundle.
        const matchId = [...matchIds][0];
        for (let i = 0; i < mvh.hubs.length; i++) {
            const rows = await mvh.hubs[i].db.doQuery(
                'SELECT validator_signatures, status FROM cross_chain_matches WHERE match_id = ?', [matchId]);
            assert.strictEqual(rows.length, 1, 'hub ' + i + ' has no cross_chain_matches row');
            assert.strictEqual(rows[0].status, 'finalized', 'hub ' + i + ' row not finalized');
            const sigs = JSON.parse(rows[0].validator_signatures || '[]');
            assert.ok(sigs.length >= 3, 'hub ' + i + ' persisted only ' + sigs.length + ' sigs');
        }
    });

    it('a byzantine validator on a divergent book is excluded, honest majority still finalizes', async function () {
        // Honest book (fill 40) for 3 hubs; divergent book (fill 30 → a different
        // canonical for the SAME match_id) for the byzantine hub, which will reject
        // the leader's PROPOSE on the canonical check and withhold its signature.
        book.setBook('shared', {
            network: NETWORK, latestBlockIndex: 200,
            ordersByCoin: crossingPair({ ltcIdx: 11, dogeIdx: 21, dogeGive: '40' })
        });
        book.setBook('divergent', {
            network: NETWORK, latestBlockIndex: 200,
            ordersByCoin: crossingPair({ ltcIdx: 11, dogeIdx: 21, dogeGive: '30' })
        });

        // The byzantine hub MUST be a non-leader (a byzantine leader would propose the
        // wrong canonical and the round would stall to view-change). Leader is
        // deterministic: sorted(pubkeys)[(matchIdInt + view) % N].
        const dex0 = mvh.getCrossChainDexes()[0];
        const lo = { home_network: NETWORK, home_coin: 'DOGE', action_index: 21 };
        const hi = { home_network: NETWORK, home_coin: 'LTC',  action_index: 11 };
        const matchId = dex0._deriveMatchId(lo, hi, BLOCK_INDEX, '0', '0');
        const validatorObjs = mvh.getPubkeys().map((pk) => ({ pubkey: pk }));
        const leaderPubkey = dex0.consensus._leaderFor(matchId, validatorObjs, 0);
        const byzIdx = mvh.getPubkeys().findIndex((pk) => pk.toLowerCase() !== leaderPubkey);
        assert.ok(byzIdx >= 0, 'could not pick a non-leader byzantine hub');
        const byzPubkey = mvh.getPubkeys()[byzIdx].toLowerCase();

        // Repoint only the byzantine hub at the divergent book.
        const byzDex = mvh.getCrossChainDexes()[byzIdx];
        const savedIndexers = JSON.parse(JSON.stringify(byzDex.indexers));
        byzDex.indexers.LTC  = { url: book.urlFor('divergent', 'LTC'),  key: '' };
        byzDex.indexers.DOGE = { url: book.urlFor('divergent', 'DOGE'), key: '' };

        try {
            const events = await driveRound();
            const honest = events.filter((e) => e.hubIndex !== byzIdx);
            const byz    = events.filter((e) => e.hubIndex === byzIdx);

            // The honest majority finalized the TRUE match with a real 2f+1 of distinct
            // verifying signatures, none of them the byzantine validator's.
            assert.ok(honest.length >= 3, 'honest majority failed to finalize (got ' + honest.length + ')');
            for (const ev of honest) {
                const ok = verifyingPubkeys(ev);
                assert.ok(ok.size >= 3, 'honest hub ' + ev.hubIndex + ' finalized with < 3 verifying sigs (' + ok.size + ')');
                assert.ok(!ok.has(byzPubkey), 'byzantine pubkey appeared in an honest finalize signature set');
            }

            // The byzantine validator (divergent canonical) CANNOT produce a settleable
            // match: even if it locally finalizes on peer COMMIT count, its signature
            // bundle holds < quorum VALID sigs over its own canonical, so the indexer's
            // cross_settle (which re-verifies 2f+1) would reject it. This is the safety
            // boundary — a bad view harms only itself, never the federation's settlement.
            for (const ev of byz) {
                const ok = verifyingPubkeys(ev);
                assert.ok(ok.size < 3,
                    'byzantine node reached a VALID quorum on a divergent canonical (' + ok.size + ' sigs) — safety violation');
            }
        } finally {
            byzDex.indexers = savedIndexers;
        }
    });

    it('with 2 of 4 faulty, quorum is unreachable and NO match finalizes (safety)', async function () {
        book.setBook('shared', {
            network: NETWORK, latestBlockIndex: 200,
            ordersByCoin: crossingPair({ ltcIdx: 12, dogeIdx: 22 })
        });

        // Silence two hubs' DEX consensus — only 2 honest remain, below quorum 3.
        const restore0 = silenceDexValidator(mvh.hubs[0]);
        const restore1 = silenceDexValidator(mvh.hubs[1]);
        try {
            const events = await driveRound();
            assert.strictEqual(events.length, 0,
                'a match finalized despite 2 of 4 faulty (quorum should be unreachable): ' +
                JSON.stringify(events.map((e) => ({ hub: e.hubIndex, sigs: (e.signatures || []).length }))));
        } finally {
            restore0();
            restore1();
        }
    });
});
