'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const {
    pickUnusedBlock,
    unusedBtcSnapshotBlock,
    pinMeshSignerSet
} = require('../../../helpers/flag_days/snapshot_block');

describe('flag_days snapshot_block', function () {
    it('picks the highest block at least 12 under the BTC tip with no capability rows', function () {
        assert.strictEqual(pickUnusedBlock(48067, new Set()), 48055);
        assert.strictEqual(pickUnusedBlock(48067, new Set([48055, 48054])), 48053);
        assert.strictEqual(pickUnusedBlock(5, new Set([0])), null);
    });

    it('never answers a DOGE-sized height on a BTC chain (1747215 against a tip of 48067)', function () {
        const block = pickUnusedBlock(48067, new Set());
        assert.ok(block <= 48067 - 12 && block >= 48067 - 1024);
    });

    it('lets a pinned override win without touching the indexer', async function () {
        const block = await unusedBtcSnapshotBlock({
            indexerQuery: async () => { throw new Error('not reached'); }, env: {}, override: '4242'
        });
        assert.strictEqual(block, 4242);
    });

    it('refuses without a BTC indexer URL rather than guessing', async function () {
        await assert.rejects(unusedBtcSnapshotBlock({ indexerQuery: async () => [], env: {} }),
            /BTC_INDEXER_API_URL is not set/);
    });

    it('reads the BTC tip and skips the occupied blocks', async function () {
        const saved = global.fetch;
        global.fetch = async (url, init) => {
            assert.strictEqual(url, 'http://btc:3024');
            assert.strictEqual(JSON.parse(init.body).method, 'getlatestblock');
            return { ok: true, json: async () => ({ result: { block_index: 1000 } }) };
        };
        try {
            const block = await unusedBtcSnapshotBlock({
                env: { BTC_INDEXER_API_URL: 'http://btc:3024' },
                indexerQuery: async (sql, params) => {
                    assert.deepStrictEqual(params, [0, 988]);
                    return [{ snapshot_block: 988 }, { snapshot_block: '987' }];
                }
            });
            assert.strictEqual(block, 986);
        } finally { global.fetch = saved; }
    });

    it('pins every hub to the mesh keys and ignores later chain-set refreshes', function () {
        const hubs = [{ peerManager: {} }, { peerManager: {} }];
        const keys = pinMeshSignerSet({ hubs, getPubkeys: () => ['AA', 'BB'] });
        assert.deepStrictEqual([...keys], ['aa', 'bb']);
        for(const hub of hubs){
            hub.peerManager.setEffectiveSignerSet(new Set(['cc']));
            assert.deepStrictEqual([...hub.peerManager.effectiveSignerSet], ['aa', 'bb']);
        }
    });
});
