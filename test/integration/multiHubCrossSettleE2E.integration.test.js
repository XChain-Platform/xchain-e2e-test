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
 * Track C.2 — Cross-chain DEX match → indexer CROSS_SETTLE end-to-end.
 *
 * The in-process DEX PBFT tests prove a match finalizes with a 2f+1 signature
 * bundle, but they stop at the hub's cross_chain_matches row. The indexer's
 * cross_settle.js (which RE-verifies those signatures against the locked
 * capability snapshot and releases escrow) was only unit-tested with SYNTHETIC
 * rows/sigs. This closes the gap by feeding a REAL multi-hub-finalized match row
 * into the real indexer handler — proving the cross-repo canonical alignment
 * (hub _canonicalMatch ↔ indexer _canonical) and the multi-sig quorum end to end:
 *   - POSITIVE: the federated row passes signature + weighted-quorum verification
 *     → cross_settle reaches STATUS='valid' and records the settlement;
 *   - NEGATIVE: a tampered signature bundle fails quorum → no settlement.
 *
 * Round mechanics mirror multiHubCrossChainDex.integration.test.js. The handler
 * is driven constructor-fully with an inline mock context; the pure
 * stake-weighted-quorum math runs through a real IndexerUtility prototype (the
 * impure DB/ledger calls are stubbed). The indexer is resolved by monorepo path;
 * the in-process venue needs an ~/xchain-indexer sibling.
 *
 * Disposable Docker MariaDB; skips when neither an env DB nor Docker is available.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const path   = require('path');
const assert = require('assert');
const { MultiValidatorHub }      = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb }   = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }     = require('../helpers/seededWeightSnapshot');
const { MockCrossChainOfferBook, makeOrder } = require('../helpers/mockCrossChainOfferBook');

const CrossSettle    = require(path.resolve(__dirname, '../../../xchain-indexer/src/actions/cross_settle.js'));
const IndexerUtility = require(path.resolve(__dirname, '../../../xchain-indexer/src/utility.js'));

const COUNT        = 4;
const PEER_WAIT_MS = 8000;
const SETTLE_MS    = 6000;
const BLOCK_INDEX  = 100;
const NETWORK      = 'regtest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Inline mock indexer context. Pure stake-weighted-quorum math runs through a
// real IndexerUtility prototype; impure DB/ledger calls are stubbed and counted.
function makeCtx(coin, pubkeys) {
    const calls = { getOrderInfo: 0, getSwapInfo: 0, createOrderStatus: 0, createSwapStatus: 0, recordSettlement: 0 };
    const util = Object.create(IndexerUtility.prototype);
    util.processTransactionLedgerChanges = async () => {};
    util.getAddressesList = () => ({});
    util.addAddressTicker = () => {};
    util.transferTokenOwnership = async () => {};
    const validators = pubkeys.map((pk, i) => ({ pubkey: pk, source: 'src' + i, weight: '1000' }));
    const indexerDb = {
        getStakeWeightsByCapability: async () => validators,
        getValidatorsByCapability:   async () => pubkeys.map((pk) => ({ pubkey: pk })),
        getOrderInfo: async () => { calls.getOrderInfo++; return { ORDER_STATUS: 'open', SOURCE: 'srcaddr' }; },
        getSwapInfo:  async () => { calls.getSwapInfo++;  return { SWAP_STATUS:  'open', SOURCE: 'srcaddr' }; },
        createActionIndex: async () => 9001,
        recordCrossChainOrderFill: async () => {},
        getOrderAmountsRemaining: async () => ['0'],
        createOrderStatus: async () => { calls.createOrderStatus++; },
        createSwapStatus:  async () => { calls.createSwapStatus++; },
        recordCrossChainSettlement: async () => { calls.recordSettlement++; },
        updateBalances: async () => {},
    };
    const mapper = { createMappings: async () => {} };
    const ctx = { config: { COIN: coin, NETWORK: NETWORK }, util, mapper, decoderDb: {}, indexerDb };
    return { ctx, calls };
}

describe('MultiValidatorHub — cross-chain DEX match → indexer CROSS_SETTLE e2e (C.2)', function () {
    this.timeout(240_000);

    let db, mvh, seed, book, matchRow, pubkeys;

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) { console.log('Skipping cross-settle e2e — no env DB and Docker unavailable'); this.skip(); }

        book = new MockCrossChainOfferBook();
        await book.start();

        mvh = new MultiValidatorHub({
            count: COUNT, basePort: 26300,
            startCrossChain: true, startAttestation: false,
            crossChainIndexerUrls: { LTC: book.urlFor('shared', 'LTC'), DOGE: book.urlFor('shared', 'DOGE') }
        });
        await mvh.start();
        await sleep(PEER_WAIT_MS);
        // regtest activates stake-weighted quorum (height 0); the DEX round needs
        // a weight snapshot. Equal weights → quorum behaves as count-3 → ≥3 sigs.
        const ids = mvh.identities;
        seed = seedWeightSnapshot(mvh, {
            blockIndex: BLOCK_INDEX,
            validators: [
                { pubkey: ids[0].pubkeyHex, source: 'sA', weight: '1000' },
                { pubkey: ids[1].pubkeyHex, source: 'sB', weight: '1000' },
                { pubkey: ids[2].pubkeyHex, source: 'sC', weight: '1000' },
                { pubkey: ids[3].pubkeyHex, source: 'sD', weight: '1000' },
            ],
        });
        pubkeys = mvh.getPubkeys().map((p) => String(p).toLowerCase());

        // Drive one real DEX round → finalized cross_chain_matches row.
        book.setBook('shared', { network: NETWORK, latestBlockIndex: 200, ordersByCoin: crossingPair({ ltcIdx: 10, dogeIdx: 20 }) });
        const dexes = mvh.getCrossChainDexes();
        const events = [];
        const listeners = dexes.map((d, i) => { const fn = (ev) => events.push(Object.assign({ hubIndex: i }, ev)); d.consensus.on('match:finalized', fn); return fn; });
        await Promise.all(dexes.map((d) => d._discoverAndMatch().catch(() => {})));
        await sleep(SETTLE_MS);
        dexes.forEach((d, i) => d.consensus.removeListener('match:finalized', listeners[i]));

        if (events.length) {
            const matchId = events[0].matchId;
            const rows = await mvh.hubs[0].db.doQuery('SELECT * FROM cross_chain_matches WHERE match_id = ?', [matchId]);
            matchRow = rows[0];
        }
    });

    after(async function () {
        if (seed) seed.restore();
        if (book) await book.stop();
        if (mvh)  { await mvh.stop(); await mvh.dropDatabases(); }
        if (db)   { await db.stop(); }
    });

    it('a real multi-hub finalized match exists with a 2f+1 signature bundle', function () {
        assert.ok(matchRow, 'the DEX round did not finalize a cross_chain_matches row');
        assert.strictEqual(matchRow.status, 'finalized', 'match row is not finalized');
        const sigs = JSON.parse(matchRow.validator_signatures || '[]');
        assert.ok(sigs.length >= 3, 'expected >= 3 signatures in the federated bundle, got ' + sigs.length);
    });

    it('the federated match passes indexer signature + weighted-quorum verification and settles', async function () {
        assert.ok(matchRow, 'no finalized match row from before()');
        const { ctx, calls } = makeCtx(matchRow.a_chain, pubkeys);
        const handler = new CrossSettle(ctx);
        const data = { MATCH: matchRow, BLOCK_INDEX: 200 };

        await handler.parse(null, data, null);

        assert.strictEqual(data.STATUS, 'valid', 'cross_settle did not validate the real federated match (canonical/quorum mismatch?)');
        assert.ok(calls.recordSettlement >= 1, 'settlement was not recorded for a valid federated match');
        assert.ok(calls.createOrderStatus + calls.createSwapStatus >= 1, 'the settled leg was not completed');
    });

    it('a tampered signature bundle fails quorum — no settlement', async function () {
        assert.ok(matchRow, 'no finalized match row from before()');
        const tampered = Object.assign({}, matchRow);
        const sigs = JSON.parse(matchRow.validator_signatures || '[]').map((s) => ({
            pubkey: s.pubkey,
            // Flip the last hex nibble of each sig → every signature fails to verify.
            sig: String(s.sig).slice(0, -1) + (String(s.sig).slice(-1) === '0' ? '1' : '0')
        }));
        tampered.validator_signatures = JSON.stringify(sigs);

        const { ctx, calls } = makeCtx(tampered.a_chain, pubkeys);
        const handler = new CrossSettle(ctx);
        const data = { MATCH: tampered, BLOCK_INDEX: 200 };

        await handler.parse(null, data, null);

        assert.notStrictEqual(data.STATUS, 'valid', 'a tampered bundle was accepted — quorum/signature check failed open');
        assert.strictEqual(calls.recordSettlement, 0, 'a settlement was recorded for a tampered (sub-quorum) match');
    });
});
