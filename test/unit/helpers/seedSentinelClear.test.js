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

// On a venue whose own hub publishes XCHAIN/USD, suppressing new seeds is
// necessary but not sufficient: rows a pre-flag run already wrote carry sentinel
// round numbers far above any round a hub reaches, and getLatestPrice orders by
// round_number DESC, so they shadow every derived round forever. Observed on BTC
// regtest answering feequote from round 888100002 at $2.00 while the hub had
// derived ~1948 at ~12.90, which made every fee proof on that venue meaningless
// while looking green.
//
// The delete must stay SURGICAL - only the suite's own sentinel rounds - because
// on a publishing venue the derived rows are the thing under test. clearPair's
// blunt "DELETE ... WHERE coin_pair = ?" would destroy exactly what the run reads.
//
// The fake driver goes in through proxyquire rather than require.cache surgery,
// which is what produced an earlier load-order trap (a suite that only passed
// while it happened to be the first file to require db.js).

const assert     = require('assert')
const proxyquire = require('proxyquire')

const { SEED_SENTINEL_ROUNDS } = require('../../helpers/xchainPriceConstants')

// Fresh helper per case, wired to a driver that records the SQL it is handed.
function loadHelper(affectedRows){
    const seen = []
    const helper = proxyquire('../../helpers/priceSnapshotHelper', {
        mariadb: {
            createConnection: async () => ({
                query: async (sql, args) => { seen.push({ sql, args }); return { affectedRows: affectedRows } },
                end:   async () => {},
            }),
            '@noCallThru': true,
        },
    })
    return { helper, seen }
}

describe('seed-sentinel clearing', () => {

    let savedIndexerDb
    beforeEach(() => {
        savedIndexerDb = global.indexerDatabase
        global.indexerDatabase = { host: 'mariadb', port: 3306, dbName: 'XChain_BTC_Regtest_Indexer', user: 'idx', pass: 'p' }
    })
    afterEach(() => { global.indexerDatabase = savedIndexerDb })

    it('deletes only the sentinel rounds, never a whole pair', async () => {
        const { helper, seen } = loadHelper(2)
        await helper.clearSeedSentinels()

        assert.strictEqual(seen.length, 1)
        const { sql, args } = seen[0]
        assert.match(sql, /^DELETE FROM price_snapshots WHERE round_number IN \(/)
        assert.ok(!/coin_pair/.test(sql), 'an unscoped call must not narrow or widen by pair')
        assert.deepStrictEqual(args, SEED_SENTINEL_ROUNDS.slice())
        // The blunt form is the one that would destroy the derived rows.
        assert.ok(!/WHERE coin_pair = \?\s*$/.test(sql))
    })

    it('scopes to one pair when asked, keeping the round filter', async () => {
        const { helper, seen } = loadHelper(1)
        await helper.clearSeedSentinels('XCHAIN/USD')

        const { sql, args } = seen[0]
        assert.match(sql, /round_number IN \(.*\) AND coin_pair = \?$/)
        assert.strictEqual(args[args.length - 1], 'XCHAIN/USD')
        assert.strictEqual(args.length, SEED_SENTINEL_ROUNDS.length + 1)
    })

    it('reports how many rows it retracted', async () => {
        const { helper } = loadHelper(7)
        assert.strictEqual(await helper.clearSeedSentinels(), 7)
    })

    it('every sentinel outranks any round a hub could plausibly reach', () => {
        // This is the property that makes a leftover row poisonous, and the reason
        // the clear exists rather than "just seed a higher round".
        for (const r of SEED_SENTINEL_ROUNDS)
            assert.ok(r > 900000, 'sentinel ' + r + ' must sit above real hub rounds')
    })

    it('is the single definition the live-oracle assertion also reads', () => {
        // The list used to be declared twice, kept in lockstep by a comment.
        const src = require('fs').readFileSync(
            require.resolve('../../sdk/nativeFeeOracleLive.sdk.test.js'), 'utf8')
        assert.ok(/new Set\(SEED_SENTINEL_ROUNDS\)/.test(src),
            'nativeFeeOracleLive must build its sentinel set from the shared list')
        assert.ok(!/888100001,\s*888100002/.test(src),
            'nativeFeeOracleLive must not re-declare the sentinel values')
    })

    it('the no-seed path clears leftovers instead of only skipping', () => {
        const src = require('fs').readFileSync(
            require.resolve('../../helpers/nativeFeeHelper.js'), 'utf8')
        const suppression = src.slice(src.indexOf('if (NO_PRICE_SEED)'))
        assert.ok(/clearSeedSentinels\(\)/.test(suppression.slice(0, 1200)),
            'suppressing the seed must also retract rows an earlier run wrote')
    })
})
