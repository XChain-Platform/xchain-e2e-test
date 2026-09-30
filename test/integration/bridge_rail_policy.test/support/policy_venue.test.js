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

const {
    policyBridgeRailVenue,
    readableHeight,
    repairUnreadableIndexers,
} = require('./policy_venue');

describe('policy rail venue indexer recovery', function () {
    it('distinguishes a readable zero height from an absent height', function () {
        assert.strictEqual(readableHeight({ body: { indexerBlock: 0 } }), 0);
        assert.strictEqual(readableHeight({ body: { indexerBlock: null } }), null);
        assert.strictEqual(readableHeight({ body: 'unavailable' }), null);
    });

    it('rebuilds only the persistent indexer that has no readable height', async function () {
        const killed = [];
        const dropped = [];
        const spawned = [];
        let repaired = false;
        const indexers = [
            { index: 0, indexerDbName: 'Readable', proc: {} },
            { index: 1, indexerDbName: 'Unreadable', proc: {} },
        ];
        const venue = {
            indexers,
            statusOf: async (index) => ({ body: { indexerBlock: index === 0 || repaired ? 123 : null } }),
            _kill: async (proc) => { killed.push(proc); },
            _conn: { query: async (sql) => { dropped.push(sql); } },
            _spawnIndexer: async (index) => { spawned.push(index); repaired = true; },
            logTail: () => 'indexer tail',
        };
        const repairedIndexes = await repairUnreadableIndexers(venue, {
            rounds: 2,
            sleep: async () => {},
        });
        assert.deepStrictEqual(repairedIndexes, [1]);
        assert.strictEqual(killed.length, 1);
        assert.deepStrictEqual(dropped, ['DROP DATABASE IF EXISTS `Unreadable`']);
        assert.deepStrictEqual(spawned, [1]);
        assert.strictEqual(indexers[1].proc, null);
    });

    it('does not rebuild an indexer whose height becomes readable during the wait', async function () {
        let reads = 0;
        const venue = {
            indexers: [{ index: 0 }],
            statusOf: async () => ({ body: { indexerBlock: reads++ ? 321 : null } }),
            _kill: async () => { assert.fail('a transient startup must not be rebuilt'); },
        };
        const repaired = await repairUnreadableIndexers(venue, {
            rounds: 2,
            sleep: async () => {},
        });
        assert.deepStrictEqual(repaired, []);
        assert.strictEqual(reads, 2);
    });

    it('fails promptly when a rebuilt indexer still has no readable height', async function () {
        const venue = {
            indexers: [{ index: 3, indexerDbName: 'StillUnreadable', proc: {} }],
            statusOf: async () => ({ body: { indexerBlock: null } }),
            _kill: async () => {},
            _conn: { query: async () => {} },
            _spawnIndexer: async () => {},
        };
        await assert.rejects(repairUnreadableIndexers(venue, {
            rounds: 1,
            sleep: async () => {},
        }), /still have no readable height after rebuild: 3/);
    });

    it('checks policy BTC indexers after the base venue starts', async function () {
        const calls = [];
        class BaseVenue {
            constructor() {
                this.label = 'bridgerailpolicy';
                this.btcVenue = {
                    indexers: [{ index: 0 }],
                    statusOf: async () => ({ body: { indexerBlock: 42 } }),
                };
            }
            async start() { calls.push('start'); return true; }
        }
        const PolicyVenue = policyBridgeRailVenue(BaseVenue);
        const venue = new PolicyVenue();
        assert.strictEqual(await venue.start(), true);
        assert.deepStrictEqual(calls, ['start']);
    });
});
