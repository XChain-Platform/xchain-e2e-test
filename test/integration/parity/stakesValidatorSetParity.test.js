/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 * SPV Phase 5: stakes_root validator-set commitment parity (indexer <-> sync).
 *
 * The validator-set proof (spec §7) needs the stakes_root to commit, per member,
 * the staking SOURCE + weight (so a light client can SOURCE-dedupe signer stake
 * exactly as swq.meetsStakeThreshold does), plus a __total__ leaf holding the
 * source-deduped quorum denominator S. The indexer commits this and the xchain-sync
 * follower recomputes it; a single byte of drift forks the stakes_root and HALTs
 * replicas. This guards the two gatherStakeEntries twins against each other AND pins
 * the exact leaf encoding (member = source+weight, total = source-deduped sum).
 *
 * The edge fixture and the seeded fuzz drive the row loop both twins share: the
 * zero-weight skip (including the '0.00000000' spelling each side canonicalises with
 * its own helper), null weight, null pubkey, null row, first-wins source dedupe with
 * unequal weights, and a capability whose rows are all zero. Each twin is called with
 * its own signature, and the capability and height each one queries are compared.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const ROOT   = path.resolve(__dirname, '../../../..');

const M       = require(path.join(ROOT, 'xchain-indexer/src/consensus/merkle.js'));
// Both twins moved their state commitment entry to src/state_commitment/index.js in their
// code-structure passes; a sibling from before its move still carries the flat file, so
// each side loads whichever spelling it has.
const present = (...rels) => rels.map((rel) => path.join(ROOT, rel)).find((p) => fs.existsSync(p)) || path.join(ROOT, rels[0]);
const idxSC   = require(present('xchain-indexer/src/state_commitment/index.js', 'xchain-indexer/src/stateCommitment.js'));
const syncSC  = require(present('xchain-sync/src/state_commitment/index.js', 'xchain-sync/src/stateCommitment.js'));
const CC      = require(path.join(ROOT, 'xchain-sync/src/consensus-constants.js'));

const CAPS = CC.btcStakeCapabilities();        // both twins iterate this BTC capability set
const CAP  = 'oracle_publish';

// Source S1 has TWO pubkeys (same per-source weight 10); source S2 has one (30).
// Source-deduped total S = 10 + 30 = 40, NOT 10 + 10 + 30 = 50: the double-pubkey
// source counts ONCE (the exact bug the source-aware leaf + __total__ leaf fix).
const ROWS = {
    oracle_publish: [
        { pubkey: 'aa'.repeat(32), source: 'S1', weight: '10' },
        { pubkey: 'bb'.repeat(32), source: 'S1', weight: '10' },
        { pubkey: 'cc'.repeat(32), source: 'S2', weight: '30' }
    ]
};

// Record every stake-weight query so the arguments each twin sends can be compared.
function mockDb(rows = ROWS){
    const calls = [];
    return {
        calls: calls,
        config: { STAKING: { CAPABILITIES: CAPS } },
        async getStakeWeightsByCapability(...args){ calls.push(args); return rows[args[0]] || []; }
    };
}

const HEIGHT = 100;
const norm   = (e) => e.map(([k, v]) => k + '=' + v).sort();

// Run both twins over the same rows, each with its own signature: sync is (db, chain, network, blockIndex).
async function bothTwins(rows){
    const idxDb = mockDb(rows), syncDb = mockDb(rows);
    const a = await idxSC.gatherStakeEntries(idxDb, HEIGHT);
    const b = await syncSC.gatherStakeEntries(syncDb, 'BTC', 'regtest', HEIGHT);
    return { a: a, b: b, idxCalls: idxDb.calls, syncCalls: syncDb.calls };
}

const CAP2 = Object.keys(CAPS).find((k) => k !== CAP);
const EDGE_ROWS = {
    oracle_publish: ROWS.oracle_publish.concat([
        { pubkey: 'dd'.repeat(32), source: 'S3',  weight: '0' },
        { pubkey: 'd1'.repeat(32), source: 'S3b', weight: '0.00000000' },
        { pubkey: 'ee'.repeat(32), source: 'S4',  weight: null },
        { pubkey: null,            source: 'S5',  weight: '5' },
        null,
        { pubkey: 'f1'.repeat(32), source: 'S7',  weight: '0.1' },
        { pubkey: 'f2'.repeat(32), source: 'S8',  weight: '0.2' },
        { pubkey: 'f3'.repeat(32), source: 'S6',  weight: '7' },
        { pubkey: 'f4'.repeat(32), source: 'S6',  weight: '9' }
    ]),
    [CAP2]: [
        { pubkey: 'aa'.repeat(32), source: 'S1', weight: '0' },
        { pubkey: 'bb'.repeat(32), source: 'S2', weight: null }
    ]
};

// Build the edge fixture's leaves by hand: S6 counts its first weight 7, so S = 10+30+0.1+0.2+7.
function expectedEdgeLeaves(){
    const member = (pk, source, w) => [M.toHex(M.stakeKey(pk, CAP)), M.toHex(M.stakeMemberLeaf(source, w))];
    return [
        member('aa'.repeat(32), 'S1', '10'), member('bb'.repeat(32), 'S1', '10'),
        member('cc'.repeat(32), 'S2', '30'), member('f1'.repeat(32), 'S7', '0.1'),
        member('f2'.repeat(32), 'S8', '0.2'), member('f3'.repeat(32), 'S6', '7'),
        member('f4'.repeat(32), 'S6', '9'),
        [M.toHex(M.stakeKey(M.STAKE_TOTAL_PUBKEY, CAP)), M.toHex(M.stakeTotalLeaf('47.3'))]
    ];
}

// Draw a deterministic stream in [0, 1) from a fixed seed.
function makeRng(seed){
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const FUZZ_PUBKEYS = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'].map((b) => b.repeat(32));
const FUZZ_SOURCES = ['S1', 'S2', 'S3', 'S4'];
const FUZZ_WEIGHTS = ['0', '0.00000000', null, '1', '10', '30', '0.1', '0.2', '7', '9', '123.45678901'];
const pick = (rng, list) => list[Math.floor(rng() * list.length)];

// Draw one row, occasionally a null row or a null pubkey.
function fuzzRow(rng){
    const roll = rng();
    if(roll < 0.04) return null;
    const pubkey = roll < 0.08 ? null : pick(rng, FUZZ_PUBKEYS);
    return { pubkey: pubkey, source: pick(rng, FUZZ_SOURCES), weight: pick(rng, FUZZ_WEIGHTS) };
}

// Draw 0-8 rows for every capability both twins iterate.
function fuzzRows(rng){
    const rows = {};
    for(const cap of Object.keys(CAPS))
        rows[cap] = Array.from({ length: Math.floor(rng() * 9) }, () => fuzzRow(rng));
    return rows;
}

describe('SPV Phase 5: stakes_root validator-set parity (indexer <-> sync)', function () {

    it('indexer and sync gatherStakeEntries produce byte-identical stake leaves', async function () {
        const r = await bothTwins(ROWS);
        assert.deepStrictEqual(norm(r.a), norm(r.b), 'indexer/sync stakes leaves diverged');
    });

    it('both twins query every capability at the same block height', async function () {
        const r = await bothTwins(ROWS);
        const capsOf = (calls) => calls.map((c) => c[0]).sort();
        assert.deepStrictEqual(capsOf(r.idxCalls), Object.keys(CAPS).sort());
        assert.deepStrictEqual(capsOf(r.syncCalls), capsOf(r.idxCalls));
        for(const c of r.idxCalls.concat(r.syncCalls))
            assert.strictEqual(c[1], HEIGHT, 'capability ' + c[0] + ' queried at ' + c[1]);
        for(const c of r.syncCalls) assert.deepStrictEqual(c.slice(4), ['BTC', 'regtest']);
    });

    it('zero, null and duplicate-source rows yield the same hand-built leaves on both twins', async function () {
        const r = await bothTwins(EDGE_ROWS);
        assert.deepStrictEqual(norm(r.a), norm(r.b), 'indexer/sync diverged on the edge fixture');
        assert.deepStrictEqual(norm(r.a), norm(expectedEdgeLeaves()));
        const keys = new Set(r.a.map(([k]) => k));
        assert.ok(!keys.has(M.toHex(M.stakeKey(M.STAKE_TOTAL_PUBKEY, CAP2))), 'all-zero capability has no total leaf');
    });

    it('seeded fuzz over weight spellings and null rows keeps the twins byte-identical', async function () {
        const seed = 0x5eed57a4, rng = makeRng(seed);
        for(let i = 0; i < 300; i += 1){
            const r = await bothTwins(fuzzRows(rng));
            assert.deepStrictEqual(norm(r.a), norm(r.b), 'twins diverged at seed ' + seed + ' iteration ' + i);
        }
    });

    it('member leaves commit (source, weight); the __total__ leaf is source-deduped', async function () {
        const map = new Map(await idxSC.gatherStakeEntries(mockDb(), 100));
        // Two pubkeys of source S1 each commit (S1, 10); S2 commits (S2, 30).
        assert.strictEqual(map.get(M.toHex(M.stakeKey('aa'.repeat(32), CAP))), M.toHex(M.stakeMemberLeaf('S1', '10')));
        assert.strictEqual(map.get(M.toHex(M.stakeKey('bb'.repeat(32), CAP))), M.toHex(M.stakeMemberLeaf('S1', '10')));
        assert.strictEqual(map.get(M.toHex(M.stakeKey('cc'.repeat(32), CAP))), M.toHex(M.stakeMemberLeaf('S2', '30')));
        // The total leaf commits 40 (source-deduped), NOT 50 (raw pubkey sum).
        const totalKey = M.toHex(M.stakeKey(M.STAKE_TOTAL_PUBKEY, CAP));
        assert.strictEqual(map.get(totalKey), M.toHex(M.stakeTotalLeaf('40')));
        assert.notStrictEqual(map.get(totalKey), M.toHex(M.stakeTotalLeaf('50')));
    });

    it('a capability with no stakers commits neither member nor total leaf', async function () {
        const empty = { config: { STAKING: { CAPABILITIES: CAPS } }, async getStakeWeightsByCapability(){ return []; } };
        assert.deepStrictEqual(await idxSC.gatherStakeEntries(empty, HEIGHT), []);
        assert.deepStrictEqual(await syncSC.gatherStakeEntries(empty, 'BTC', 'regtest', HEIGHT), []);
    });

    it('sumCanonicalAmounts is exact and matches across the merkle twins', function () {
        assert.strictEqual(M.sumCanonicalAmounts(['10', '30']), M.canonicalAmount('40'));
        assert.strictEqual(M.sumCanonicalAmounts(['0.1', '0.2']), M.canonicalAmount('0.3'));   // no float drift
        assert.strictEqual(M.sumCanonicalAmounts([]), M.canonicalAmount('0'));
    });
});
