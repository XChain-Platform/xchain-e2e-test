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

// The window rule for the DOGE setup drivers' price fixture, pinned.
//
// A snapshot at S is usable by a block at time B only inside S <= B <= S + maxAge.
// A single row at the DOGE indexer's parsed tip is the wrong choice on an idle
// chain: the tip is whatever was last mined, while the blocks the driver is about
// to mine take wall-clock time, so the first generate_blocks jumps past the row's
// whole freshness window. Measured on the
// BTC/DOGE regtest venue 2026-09-03: seeded 1788414633, ISSUE landed at 1788427123,
// indexed `invalid: no current oracle price for DOGE/USD`.
//
// These cases keep both halves of the rule honest, because each half is easy to
// "simplify" back into the bug: dropping the wall row reinstates it, and dropping
// the tip row breaks the OTHER regime (a clock drill leaves the node pinned behind
// wall time, where a wall-anchored row sits in the future of every block and the
// H-3 selection gate excludes it outright).

const assert = require('assert')

const helper = require('../../helpers/dogeSetupPriceSeed')

// Stand-ins for the drivers' own connection wrappers. Each takes an async callback
// and hands it something query-shaped, so nothing here opens a database.
function fakeDogeIdx(tipTime){
    return async (fn) => fn({
        query: async () => (tipTime === null ? [] : [{ block_time: tipTime }]),
    })
}
// Records the INSERTs and, separately, the one DELETE that precedes them, so a case
// can assert on either without the two contaminating each other.
function recordingHub(rows, deletes){
    return async (fn) => fn({
        query: async (sql, params) => {
            if (/^DELETE/i.test(String(sql).trim())){
                if (deletes) deletes.push({ sql: String(sql), params })
                return { affectedRows: 2 }
            }
            rows.push({ round: params[0], pair: params[1], price: params[2], blockTimestamp: params[3] })
            return { affectedRows: 1 }
        },
    })
}

describe('dogeSetupPriceSeed window rule', () => {

    describe('usableSeedAnchors', () => {
        it('seeds BOTH the tip and wall-clock anchors when the chain trails', () => {
            const anchors = helper.usableSeedAnchors(1000, 1500)
            assert.strictEqual(anchors.length, 2)
            assert.deepStrictEqual(anchors.map(a => a.time), [1000, 1500])
        })

        // The load-bearing ordering. getLatestPrice takes the highest round among the
        // rows a block may see, so where both are visible the wall row (the fresher of
        // the two) must win; equal or inverted rounds would settle against the stale one.
        it('gives the wall-clock anchor the higher round', () => {
            const [chain, wall] = helper.usableSeedAnchors(1000, 1500)
            assert.ok(wall.coinRound   > chain.coinRound)
            assert.ok(wall.xchainRound > chain.xchainRound)
        })

        it('writes ONE anchor when the chain leads wall time (post-jump)', () => {
            const anchors = helper.usableSeedAnchors(2000, 1500)
            assert.deepStrictEqual(anchors.map(a => a.time), [2000])
        })

        // A tie is not "the chain trails". Emitting a second identical-timestamp row
        // would add a higher round for no freshness gain, which is exactly the shape
        // that shadows a derived round on a publishing venue.
        it('writes ONE anchor when the two clocks agree', () => {
            assert.strictEqual(helper.usableSeedAnchors(1500, 1500).length, 1)
        })

        // Never future-date the chain anchor. An anchor later than the block reading it
        // fails the selection gate and reads as no price at all.
        it('never anchors the tip row later than the tip', () => {
            for (const [chain, wall] of [[1000, 5000], [5000, 1000], [1000, 1000]])
                assert.strictEqual(helper.usableSeedAnchors(chain, wall)[0].time, chain)
        })
    })

    describe('seedDogeFixturePrices', () => {
        it('writes both pairs at every anchor, at the freshly-read tip', async () => {
            const rows = []
            const wall = Math.floor(Date.now() / 1000)
            const result = await helper.seedDogeFixturePrices({
                hubConn: recordingHub(rows), dogeIdx: fakeDogeIdx(wall - 5000),
                coinPair: 'DOGE/USD', coinUsd: 0.1, xchainUsd: '2.00000000',
                label: 'unit',
            })
            assert.strictEqual(result.anchors.length, 2, 'a tip 5000s behind wall time trails')
            assert.strictEqual(rows.length, 4)
            assert.deepStrictEqual(rows.map(r => r.pair),
                ['DOGE/USD', 'XCHAIN/USD', 'DOGE/USD', 'XCHAIN/USD'])
            assert.strictEqual(rows[0].blockTimestamp, wall - 5000)
            assert.ok(rows[2].blockTimestamp >= wall, 'the second anchor is the wall clock')
        })

        it('writes one pair when the chain leads, and re-reads the tip each call', async () => {
            const rows = []
            const ahead = Math.floor(Date.now() / 1000) + 10000
            await helper.seedDogeFixturePrices({
                hubConn: recordingHub(rows), dogeIdx: fakeDogeIdx(ahead),
                coinPair: 'DOGE/USD', coinUsd: 0.1, xchainUsd: '2.00000000', label: 'unit',
            })
            assert.strictEqual(rows.length, 2)

            // The second call is what makes it safe to re-seed before every submit: it
            // must follow the chain rather than replay the first call's answer.
            const moved = ahead + 12490
            await helper.seedDogeFixturePrices({
                hubConn: recordingHub(rows), dogeIdx: fakeDogeIdx(moved),
                coinPair: 'DOGE/USD', coinUsd: 0.1, xchainUsd: '2.00000000', label: 'unit',
            })
            assert.strictEqual(rows.length, 4)
            assert.strictEqual(rows[2].blockTimestamp, moved)
        })

        it('honours the publishing-venue suppression rather than shadowing a derived round', async () => {
            const saved = process.env.XCHAIN_E2E_NO_PRICE_SEED
            process.env.XCHAIN_E2E_NO_PRICE_SEED = '1'
            // The constants module reads the flag at load, so re-require it and the
            // helper together to pick the flag up.
            delete require.cache[require.resolve('../../helpers/xchainPriceConstants')]
            delete require.cache[require.resolve('../../helpers/dogeSetupPriceSeed')]
            const flagged = require('../../helpers/dogeSetupPriceSeed')
            const rows = []
            try {
                await assert.rejects(
                    () => flagged.seedDogeFixturePrices({
                        hubConn: recordingHub(rows), dogeIdx: fakeDogeIdx(1000),
                        coinPair: 'DOGE/USD', coinUsd: 0.1, xchainUsd: '2.00000000',
                        label: 'dexDogeSetup',
                    }),
                    /dexDogeSetup: XCHAIN_E2E_NO_PRICE_SEED=1/)
                assert.strictEqual(rows.length, 0, 'a suppressed seed must write nothing')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_E2E_NO_PRICE_SEED
                else process.env.XCHAIN_E2E_NO_PRICE_SEED = saved
                delete require.cache[require.resolve('../../helpers/xchainPriceConstants')]
                delete require.cache[require.resolve('../../helpers/dogeSetupPriceSeed')]
            }
        })
    })

    // The half that made the two-anchor fix INERT on the venue when it first ran.
    // getLatestPrice takes the highest ROUND, not the freshest timestamp, so a stale
    // row with a bigger round wins and is then rejected as stale, and the fresh row is
    // never reached. nativeFeeHelper's rounds are ~888 million against this helper's
    // ~990 thousand, so any earlier harness run on the DOGE stack shadows it forever.
    describe('shadowing fixture rounds', () => {
        it('retracts the other seed sites rounds for exactly the pairs it seeds', async () => {
            const rows = [], deletes = []
            const result = await helper.seedDogeFixturePrices({
                hubConn: recordingHub(rows, deletes), dogeIdx: fakeDogeIdx(1000),
                coinPair: 'DOGE/USD', coinUsd: 0.1, xchainUsd: '2.00000000', label: 'unit',
            })
            assert.strictEqual(deletes.length, 1, 'one retraction, before the seed')
            const params = deletes[0].params
            assert.deepStrictEqual(params.slice(0, 2), ['DOGE/USD', 'XCHAIN/USD'])
            assert.ok(params.includes(888100012),
                "nativeFeeHelper's wall-clock coin round is the one that shadowed the venue")
            assert.strictEqual(result.shadowsCleared, 2)
        })

        // Deleting its own rounds would undo the seed it is about to write on a re-run,
        // which is the failure mode of a "just clear every sentinel" simplification.
        it('never retracts the rounds it is about to write', () => {
            for (const own of [helper.CHAIN_COIN_ROUND, helper.CHAIN_XCHAIN_ROUND,
                               helper.WALL_COIN_ROUND, helper.WALL_XCHAIN_ROUND])
                assert.ok(!helper.FOREIGN_SENTINEL_ROUNDS.includes(own),
                    'round ' + own + ' is both seeded and retracted')
        })

        // A setup driver is a guest on a venue whose hub may derive the pair for real.
        // Retracting by round number keeps consensus rounds (small, monotonic) untouched;
        // a clearPair would take them with it.
        it('retracts by round number, never the whole pair', async () => {
            const deletes = []
            await helper.seedDogeFixturePrices({
                hubConn: recordingHub([], deletes), dogeIdx: fakeDogeIdx(1000),
                coinPair: 'DOGE/USD', coinUsd: 0.1, xchainUsd: '2.00000000', label: 'unit',
            })
            assert.ok(/round_number IN \(/.test(deletes[0].sql),
                'the DELETE must be scoped to the fixture rounds')
        })
    })

    // Every round this helper writes has to be one clearSeedSentinels can retract, or a
    // flagged run reports a clean venue while these rows go on outranking every derived
    // round for DOGE/USD and XCHAIN/USD. The tree-wide guard scans seed SITES; this
    // pins the four constants directly, since the sites now delegate here.
    it('writes only rounds SEED_SENTINEL_ROUNDS can retract', () => {
        const { SEED_SENTINEL_ROUNDS } = require('../../helpers/xchainPriceConstants')
        for (const round of [helper.CHAIN_COIN_ROUND, helper.CHAIN_XCHAIN_ROUND,
                             helper.WALL_COIN_ROUND, helper.WALL_XCHAIN_ROUND])
            assert.ok(SEED_SENTINEL_ROUNDS.includes(round),
                'round ' + round + ' is seeded but not retractable')
    })
})
