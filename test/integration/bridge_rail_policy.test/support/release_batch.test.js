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
 *********************************************************************/

'use strict';

const assert = require('assert');

const { settleReleaseBatch } = require('./release_batch');

describe('policy rail bootstrap release batch', function () {
    it('mines once after every release transaction reaches the mempool', async function () {
        const mempool = ['already-there'];
        let resolveMined;
        const mined = new Promise((resolve) => { resolveMined = resolve; });
        let releaseSecond;
        const secondMayBroadcast = new Promise((resolve) => { releaseSecond = resolve; });
        let mineCalls = 0;
        let sleepCalls = 0;
        const result = await settleReleaseBatch({
            entries: [{ key: 'one' }, { key: 'two' }],
            node: { getRawMempool: async () => mempool.slice() },
            send: async (entry) => {
                if (entry.key === 'two') await secondMayBroadcast;
                mempool.push(entry.key);
                await mined;
                return entry.key;
            },
            mine: async (count) => {
                mineCalls++;
                assert.strictEqual(count, 1);
                assert.deepStrictEqual(mempool, ['already-there', 'one', 'two']);
                resolveMined();
            },
            sleep: async () => {
                sleepCalls++;
                assert.strictEqual(mineCalls, 0);
                releaseSecond();
                await Promise.resolve();
            },
        });
        assert.strictEqual(mineCalls, 1);
        assert.strictEqual(sleepCalls, 1);
        assert.deepStrictEqual(result.map((entry) => entry.status), ['fulfilled', 'fulfilled']);
    });

    it('does not count transactions that preceded the release batch', async function () {
        let clock = 0;
        await assert.rejects(settleReleaseBatch({
            entries: [{ key: 'one' }],
            node: { getRawMempool: async () => ['already-there'] },
            send: async () => 'finished without a broadcast',
            mine: async () => { assert.fail('a partial release batch must not be mined'); },
            timeoutMs: 3,
            pollMs: 1,
            now: () => clock,
            sleep: async () => { clock++; },
        }), /saw 0\/1 UNSTAKE transaction/);
    });
});
