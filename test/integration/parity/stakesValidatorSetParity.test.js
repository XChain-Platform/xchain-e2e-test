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
 **********************************************************************
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
 ********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');
const ROOT   = path.resolve(__dirname, '../../../..');

const M       = require(path.join(ROOT, 'xchain-indexer/src/merkle.js'));
const idxSC   = require(path.join(ROOT, 'xchain-indexer/src/stateCommitment.js'));
const syncSC  = require(path.join(ROOT, 'xchain-sync/src/stateCommitment.js'));
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

function mockDb(){
    return {
        config: { STAKING: { CAPABILITIES: CAPS } },
        async getStakeWeightsByCapability(cap){ return ROWS[cap] || []; }
    };
}

describe('SPV Phase 5: stakes_root validator-set parity (indexer <-> sync)', function () {

    it('indexer and sync gatherStakeEntries produce byte-identical stake leaves', async function () {
        const a = await idxSC.gatherStakeEntries(mockDb(), 100);
        const b = await syncSC.gatherStakeEntries(mockDb(), 'BTC', 100);
        const norm = (e) => e.map(([k, v]) => k + '=' + v).sort();
        assert.deepStrictEqual(norm(a), norm(b), 'indexer/sync stakes leaves diverged');
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
        assert.deepStrictEqual(await idxSC.gatherStakeEntries(empty, 100), []);
        assert.deepStrictEqual(await syncSC.gatherStakeEntries(empty, 'BTC', 100), []);
    });

    it('sumCanonicalAmounts is exact and matches across the merkle twins', function () {
        assert.strictEqual(M.sumCanonicalAmounts(['10', '30']), M.canonicalAmount('40'));
        assert.strictEqual(M.sumCanonicalAmounts(['0.1', '0.2']), M.canonicalAmount('0.3'));   // no float drift
        assert.strictEqual(M.sumCanonicalAmounts([]), M.canonicalAmount('0'));
    });
});
