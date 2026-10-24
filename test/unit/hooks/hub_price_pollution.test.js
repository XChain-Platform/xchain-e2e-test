'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const {
    ROOT_HOOK_PRICE_SEED_ROUNDS,
    clearRootHookPriceSeeds,
} = require('../../helpers/xchainPriceConstants')

describe('root-hook hub price cleanup', () => {
    it('removes its fixture rows from both the disposable mirror and shared hub', async () => {
        const databases = {
            Disposable_Hub_Mirror: [
                { round: 888100001, pair: 'XCHAIN/USD' },
                { round: 888100002, pair: 'BTC/USD' },
            ],
            Shared_Rail_Hub: [
                { round: 2048, pair: 'XCHAIN/USD' },
                { round: 888100001, pair: 'XCHAIN/USD' },
                { round: 888100011, pair: 'XCHAIN/USD' },
                { round: 888100012, pair: 'BTC/USD' },
            ],
        }
        const calls = []
        const closed = []
        const connect = async (target) => ({
            query: async (sql, args) => {
                calls.push({ database: target.database, sql, args })
                const before = databases[target.database]
                databases[target.database] = before.filter(row => !args.includes(row.round))
                return { affectedRows: before.length - databases[target.database].length }
            },
            end: async () => { closed.push(target.database) },
        })

        const removed = await clearRootHookPriceSeeds([
            { database: 'Disposable_Hub_Mirror' },
            { database: 'Shared_Rail_Hub' },
        ], connect)

        assert.strictEqual(removed, 5)
        assert.deepStrictEqual(databases.Disposable_Hub_Mirror, [])
        assert.deepStrictEqual(databases.Shared_Rail_Hub,
            [{ round: 2048, pair: 'XCHAIN/USD' }])
        assert.deepStrictEqual(closed, ['Disposable_Hub_Mirror', 'Shared_Rail_Hub'])
        assert.strictEqual(calls.length, 2)
        for (const call of calls) {
            assert.match(call.sql,
                /^DELETE FROM price_snapshots WHERE round_number IN \(\?,\?,\?,\?\)$/)
            assert.deepStrictEqual(call.args, ROOT_HOOK_PRICE_SEED_ROUNDS.slice())
            assert.ok(!/coin_pair\s*=/.test(call.sql))
        }
    })

    it('wires cleanup after the normal root-hook teardown', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../initial_check.test.js'), 'utf8')
        const teardownAt = source.indexOf('await teardown.afterAll')
        const cleanupAt = source.indexOf('clearRootHookPriceSeeds')

        assert.ok(teardownAt >= 0, 'root hook must run its normal teardown')
        assert.ok(cleanupAt > teardownAt, 'price cleanup must run after stake teardown has used prices')
        assert.match(source, /hubMirrorTopology\.clearTargets\(\)/,
            'cleanup must cover both the disposable read copy and the shared hub source')
        assert.match(source, /if \(teardownError\) throw teardownError[\s\S]*if \(priceCleanupError\) throw priceCleanupError/,
            'a cleanup failure must fail the root hook instead of leaving shared state silently')
    })

    it('attempts every database and reports cleanup failures', async () => {
        const visited = []
        const connect = async (target) => {
            visited.push(target.database)
            if (target.database === 'Shared_Rail_Hub') throw new Error('shared hub unavailable')
            return { query: async () => ({ affectedRows: 2 }), end: async () => {} }
        }

        await assert.rejects(
            clearRootHookPriceSeeds([
                { database: 'Shared_Rail_Hub' },
                { database: 'Disposable_Hub_Mirror' },
            ], connect),
            /Could not remove root-hook price seeds/)
        assert.deepStrictEqual(visited, ['Shared_Rail_Hub', 'Disposable_Hub_Mirror'])
    })
})
