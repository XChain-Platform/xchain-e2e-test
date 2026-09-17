/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

/*********************************************************************
 * Force-seed fresh oracle prices before a contract-heavy action suite on a
 * fee chain. NOT a feature test (it is a venue preamble). Run it FIRST, ahead
 * of the suites that need the seed:
 *   mocha … test/actions/ctlseed.test.js test/actions/controllerPolicy.test.js
 *
 * Why: contract fee validation needs a fresh {COIN}/USD snapshot for EVERY
 * DEPLOY/EXECUTE, but the in-suite auto-seed (nativeFeeHelper.seedGlobalPrices,
 * non-force) is a no-op when a stale snapshot already exists, and a persistent
 * regtest stack's last seed expires after 1800s of block-time. Then every guard
 * contract DEPLOY indexes "invalid: no current oracle price for {COIN}/USD".
 * (Known harness flake.)
 *
 * Anchoring: priceSnapshotHelper.usableSeedAnchors() returns the chain-time
 * anchor and adds a wall-time anchor when the chain trails wall clock. Fee
 * validation on every chain except BTC selects only snapshots with a
 * `block_timestamp` at or before the processed block time. A snapshot dated
 * after that block is invisible to the lookup, even while the table contains
 * a finalized row for the pair. The chain-time anchor remains readable at the
 * current tip. The wall-time anchor covers later blocks stamped near wall clock
 * after an idle chain resumes. Seeds use ascending round numbers in anchor
 * order, giving the wall-time row selection priority when both timestamps are
 * eligible while allowing the chain-time row to match when the wall-time row
 * is beyond the processed block. Continued freshness depends on periodic
 * seeding as the chain advances, and SEED_REFRESH_MS limits refresh frequency.
 ********************************************************************/

const assert = require('assert')

const priceSnapshotHelper = require('../helpers/priceSnapshotHelper')
const { BOOTSTRAP_XCHAIN_USD, NO_PRICE_SEED } = require('../helpers/xchainPriceConstants')

// One round per (pair, anchor). Spelled out as file-local consts, and passed to
// seedSnapshot as `roundNumber: <const>`, because a coverage guard walks
// this file for that exact shape to prove every round it writes is one
// clearSeedSentinels can retract. An indirection here (rounds[i]) reads fine and
// silently drops the file from that guard.
const CHAIN_ROUND_COIN   = 990001
const CHAIN_ROUND_XCHAIN = 990002
const WALL_ROUND_COIN    = 990011
const WALL_ROUND_XCHAIN  = 990012

async function skipUnavailablePriceSnapshots(testContext) {
    // This preamble CLEARS the pair and re-seeds it, which on a
    // venue whose hub publishes prices would delete real finalized rounds and
    // shadow the rest. Hard-skip there.
    if (NO_PRICE_SEED) {
        console.log('   XCHAIN_E2E_NO_PRICE_SEED=1; venue publishes its own prices, not seeding')
        testContext.skip()
        return true
    }
    if (!(await priceSnapshotHelper.isAvailable())) {
        console.log('   price_snapshots not reachable; skipping seed (non-fee venue)')
        testContext.skip()
        return true
    }
    return false
}

async function seedFreshOraclePrices() {
    if (await skipUnavailablePriceSnapshots(this)) return
    // Both legal anchors, oldest-first, so the ascending round numbers below give
    // the wall-clock row the higher round. See usableSeedAnchors for why that
    // pairing is the one that survives all three regtest clock regimes.
    const { chainTime, wallTime, anchors } = await priceSnapshotHelper.usableSeedAnchors()
    const COIN_PAIR = `${COIN_CODE}/USD`
    const COIN_USD  = '100000.00000000'

    // `anchor` indexes usableSeedAnchors().anchors; index 1 exists only when the
    // chain trails wall clock, and those rows are skipped otherwise.
    const seeds = [
        { coinPair: COIN_PAIR,    price: COIN_USD,             anchor: 0, roundNumber: CHAIN_ROUND_COIN },
        { coinPair: 'XCHAIN/USD', price: BOOTSTRAP_XCHAIN_USD, anchor: 0, roundNumber: CHAIN_ROUND_XCHAIN },
        { coinPair: COIN_PAIR,    price: COIN_USD,             anchor: 1, roundNumber: WALL_ROUND_COIN },
        { coinPair: 'XCHAIN/USD', price: BOOTSTRAP_XCHAIN_USD, anchor: 1, roundNumber: WALL_ROUND_XCHAIN },
    ]

    for (const pair of [COIN_PAIR, 'XCHAIN/USD']) {
        const removed = await priceSnapshotHelper.clearPair(pair)
        console.log(`   cleared ${removed} existing ${pair} snapshot(s)`)
    }
    const written = { [COIN_PAIR]: 0, 'XCHAIN/USD': 0 }
    for (const s of seeds) {
        const blockTimestamp = anchors[s.anchor]
        if (blockTimestamp === undefined) continue
        await priceSnapshotHelper.seedSnapshot({
            coinPair:       s.coinPair,
            price:          s.price,
            roundNumber:    s.roundNumber,
            blockTimestamp: blockTimestamp,
        })
        written[s.coinPair]++
        console.log(`   seeded ${s.coinPair}=${s.price} @ block_timestamp ${blockTimestamp} `
            + `round ${s.roundNumber} (tip=${chainTime} now=${wallTime})`)
    }

    // The failure this preamble has actually had is seeding NOTHING while
    // reporting success: on LTC/DOGE regtest it wrote only future-dated rows,
    // which getLatestPrice cannot see, and every downstream contract DEPLOY
    // then failed with "no current oracle price" hundreds of lines later.
    // Contract fee validation needs BOTH pairs, so assert both got
    // at least one row rather than trusting the loop ran. Structural, not
    // timing-dependent: it reads only what this run just wrote.
    assert.ok(anchors.length >= 1,
        'usableSeedAnchors returned no anchor; nothing could be seeded')
    assert.ok(written[COIN_PAIR] >= 1,
        `seeded no ${COIN_PAIR} snapshot; contract fee validation will fail with "no current oracle price"`)
    assert.ok(written['XCHAIN/USD'] >= 1,
        'seeded no XCHAIN/USD snapshot; contract fee validation will fail with "no current oracle price"')
}

describe('_ctlseed: force-seed fresh oracle prices (venue preamble)', function () {
    this.timeout(0)
    it('seeds fresh finalized COIN/USD + XCHAIN/USD inside the usable anchor window', seedFreshOraclePrices)
})
