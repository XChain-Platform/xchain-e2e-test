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

// . The usable window for a seeded price snapshot is bounded on BOTH sides:
//
//     S <= B <= S + ORACLE_MAX_PRICE_AGE_SECONDS
//
// where S is the snapshot's block_timestamp and B the time of the block reading it.
// The upper bound is db.getLatestPrice's staleness guard. The lower bound is the
// H-3 selection gate, `block_timestamp <= <block time>`, which applies on every
// chain except BTC.
//
// Before H-3 only the upper bound existed, so seed sites bought headroom by
// future-dating (max(tip, now) + buffer). That is now precisely inverted: on a
// native-fee chain a future-dated row is not selected at all, so the venue answers
// "no current oracle price" with a perfectly good row in the table. _ctlseed still
// carried the retired rule and therefore seeded nothing usable on the LTC/DOGE fee
// chains it exists to unblock (measured on LTC regtest 2026-07-28).
//
// These cases pin the rule and keep the retired one from creeping back.

const assert     = require('assert')
const fs         = require('fs')
const proxyquire = require('proxyquire')

// A helper wired to a fake indexer DB reporting a fixed tip block_time, and to a
// driver that records the SQL handed to it (for the clearPair count case).
function loadHelper({ tipBlockTime, affectedRows = 0 } = {}){
    const seen = []
    const helper = proxyquire('../../helpers/priceSnapshotHelper', {
        mariadb: {
            createConnection: async () => ({
                query: async (sql, args) => { seen.push({ sql, args }); return { affectedRows } },
                end:   async () => {},
            }),
            '@noCallThru': true,
        },
    })
    global.indexerDatabase = {
        host: 'mariadb', port: 3306, dbName: 'XChain_LTC_Regtest_Indexer', user: 'idx', pass: 'p',
        getConnection: async () => ({
            query:   async () => (tipBlockTime === undefined ? [] : [{ block_time: tipBlockTime }]),
            release: async () => {},
        }),
    }
    return { helper, seen }
}

describe('price seed anchoring ', () => {

    let savedIndexerDb
    beforeEach(() => { savedIndexerDb = global.indexerDatabase })
    afterEach(() => { global.indexerDatabase = savedIndexerDb })

    it('never anchors above the chain tip, whatever the wall clock says', async () => {
        // The regime that wedged LTC regtest: blocks frozen behind wall time. Any
        // anchor above the tip fails the selection gate outright.
        const tip = Math.floor(Date.now() / 1000) - 5000
        const { helper } = loadHelper({ tipBlockTime: tip })
        const { anchors } = await helper.usableSeedAnchors()

        for (const a of anchors)
            assert.ok(a <= Math.max(tip, Math.floor(Date.now() / 1000)),
                'anchor ' + a + ' must not be future-dated past a readable block time')
        assert.ok(anchors.includes(tip), 'the tip is always a legal anchor and must be seeded')
    })

    it('adds a wall-clock anchor when the chain trails, ordered so it wins on round', async () => {
        // Idle chain: the tip lags wall clock but the miner is not pinned, so new
        // blocks are stamped ~now and a tip-anchored row is already stale. Both rows
        // are needed, and the wall row must take precedence.
        const tip = Math.floor(Date.now() / 1000) - 5000
        const { helper } = loadHelper({ tipBlockTime: tip })
        const { chainTime, wallTime, anchors } = await helper.usableSeedAnchors()

        assert.strictEqual(chainTime, tip)
        assert.strictEqual(anchors.length, 2)
        // Oldest-first. Selection is ORDER BY round_number DESC, so a caller
        // assigning ascending rounds in this order gives the wall row the higher
        // round. Reversed, the frozen regime would select a row it must then reject.
        assert.deepStrictEqual(anchors, [chainTime, wallTime])
        assert.ok(anchors[0] < anchors[1])
    })

    it('seeds the tip alone when block timestamps lead wall clock', async () => {
        // Sustained mining / post-clock-jump: a wall-clock row would sit below the
        // tip and be redundant, and on a fast chain it goes stale immediately.
        const tip = Math.floor(Date.now() / 1000) + 5000
        const { helper } = loadHelper({ tipBlockTime: tip })
        const { anchors } = await helper.usableSeedAnchors()

        assert.deepStrictEqual(anchors, [tip])
    })

    it('clearPair reports how many rows it removed', async () => {
        // It returned undefined, so it could not be used as evidence that anything
        // was deleted; a venue pricing at zero looked the same whether the clear had
        // removed a shadowing round or matched nothing at all.
        const { helper, seen } = loadHelper({ tipBlockTime: 1, affectedRows: 124 })
        assert.strictEqual(await helper.clearPair('LTC/USD'), 124)
        assert.match(seen[0].sql, /DELETE FROM price_snapshots WHERE coin_pair = \?/)
        assert.deepStrictEqual(seen[0].args, ['LTC/USD'])
    })

    it('clearPair reports zero rather than undefined when it matches nothing', async () => {
        const { helper } = loadHelper({ tipBlockTime: 1, affectedRows: 0 })
        assert.strictEqual(await helper.clearPair('LTC/USD'), 0)
    })

    it('no seed site anchors past the chain tip any more', () => {
        // The retired rule, in the shape it actually appeared in: max(tip, now) plus
        // a buffer. It survived in _ctlseed for months after H-3 made it wrong,
        // because nothing failed when a preamble seeded rows nobody could select.
        const src = fs.readFileSync(require.resolve('../../actions/_ctlseed.test.js'), 'utf8')
        assert.ok(!/Math\.max\(\s*tip\s*,\s*now\s*\)\s*\+/.test(src),
            '_ctlseed must not future-date its anchor; use usableSeedAnchors()')
        assert.ok(/usableSeedAnchors\(\)/.test(src),
            '_ctlseed must take its anchors from the shared window rule')
    })

    it('the window rule is stated where seed sites will read it', () => {
        const src = fs.readFileSync(require.resolve('../../helpers/priceSnapshotHelper.js'), 'utf8')
        const doc = src.slice(src.indexOf('usableSeedAnchors') - 2400, src.indexOf('usableSeedAnchors'))
        assert.ok(/block_timestamp <= /.test(doc), 'the lower bound (H-3 selection gate) must be named')
        assert.ok(/ORACLE_MAX_PRICE_AGE_SECONDS/.test(doc), 'the upper bound (staleness guard) must be named')
    })
})
