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
const vm = require('vm')

const xchainPriceConstants = require('../../helpers/xchainPriceConstants')

const rootHookSource = fs.readFileSync(path.join(__dirname, '../../initial_check.test.js'), 'utf8')

function rootHookCleanup() {
    const signature = 'async function clearRootHookPriceSeeds('
    const start = rootHookSource.indexOf(signature)
    assert.ok(start >= 0, 'root hook must define price-seed cleanup')
    const bodyStart = rootHookSource.indexOf('{', start)
    let depth = 0
    for (let i = bodyStart; i < rootHookSource.length; i++) {
        if (rootHookSource[i] === '{') depth++
        if (rootHookSource[i] !== '}') continue
        depth--
        if (depth === 0) {
            const source = rootHookSource.slice(start, i + 1)
            return vm.runInNewContext('(' + source + ')', { xchainPriceConstants })
        }
    }
    throw new Error('root-hook price cleanup function is incomplete')
}

describe('root-hook hub price cleanup', () => {
    it('removes every fixture row it wrote from the disposable mirror and shared hub', async () => {
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
                { round: 888100002, pair: 'DOGE/USD' },
            ],
        }
        const calls = []
        const closed = []
        const connect = async (target) => ({
            query: async (sql, args) => {
                calls.push({ database: target.database, sql, args })
                const before = databases[target.database]
                const rounds = Array.from(args.slice(0, -1))
                const pair = args.at(-1)
                databases[target.database] = before.filter(row =>
                    !rounds.includes(row.round) || row.pair !== pair)
                return { affectedRows: before.length - databases[target.database].length }
            },
            end: async () => { closed.push(target.database) },
        })

        const removed = await rootHookCleanup()([
            { database: 'Disposable_Hub_Mirror' },
            { database: 'Shared_Rail_Hub' },
        ], 'BTC', connect)

        assert.strictEqual(removed, 5)
        assert.deepStrictEqual(databases.Disposable_Hub_Mirror, [])
        assert.deepStrictEqual(databases.Shared_Rail_Hub,
            [
                { round: 2048, pair: 'XCHAIN/USD' },
                { round: 888100002, pair: 'DOGE/USD' },
            ])
        assert.deepStrictEqual(closed, ['Disposable_Hub_Mirror', 'Shared_Rail_Hub'])
        assert.strictEqual(calls.length, 4)
        for (const call of calls)
            assert.match(call.sql,
                /^DELETE FROM price_snapshots WHERE round_number IN \(\?,\?\) AND coin_pair = \?$/)
        assert.deepStrictEqual(calls.map(call => Array.from(call.args)), [
            [888100001, 888100011, 'XCHAIN/USD'],
            [888100002, 888100012, 'BTC/USD'],
            [888100001, 888100011, 'XCHAIN/USD'],
            [888100002, 888100012, 'BTC/USD'],
        ])
    })

    it('wires cleanup after the normal root-hook teardown', () => {
        const teardownAt = rootHookSource.indexOf('await teardown.afterAll')
        const cleanupAt = rootHookSource.indexOf('await clearRootHookPriceSeeds')

        assert.ok(teardownAt >= 0, 'root hook must run its normal teardown')
        assert.ok(cleanupAt > teardownAt, 'price cleanup must run after stake teardown has used prices')
        assert.match(rootHookSource, /hubMirrorTopology\.clearTargets\(\), global\.COIN_CODE\)/,
            'cleanup must cover both the disposable read copy and the shared hub source')
        assert.match(rootHookSource,
            /if \(teardownError\) throw teardownError[\s\S]*if \(priceCleanupError\) throw priceCleanupError/,
            'a cleanup failure must fail the root hook instead of leaving shared state silently')
    })

    it('attempts every database and reports cleanup failures', async () => {
        const visited = []
        const closed = []
        const connect = async (target) => ({
            query: async (sql, args) => {
                const pair = args.at(-1)
                visited.push(target.database + ':' + pair)
                if (target.database === 'Shared_Rail_Hub' && pair === 'XCHAIN/USD')
                    throw new Error('shared hub XCHAIN cleanup failed')
                return { affectedRows: 2 }
            },
            end: async () => { closed.push(target.database) },
        })

        await assert.rejects(
            rootHookCleanup()([
                { database: 'Shared_Rail_Hub' },
                { database: 'Disposable_Hub_Mirror' },
            ], 'BTC', connect),
            /Could not remove root-hook price seeds/)
        assert.deepStrictEqual(visited, [
            'Shared_Rail_Hub:XCHAIN/USD',
            'Shared_Rail_Hub:BTC/USD',
            'Disposable_Hub_Mirror:XCHAIN/USD',
            'Disposable_Hub_Mirror:BTC/USD',
        ])
        assert.deepStrictEqual(closed, ['Shared_Rail_Hub', 'Disposable_Hub_Mirror'])
    })
})
