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
 * fee chain. NOT a feature test (it is a venue preamble). Run it FIRST in the same
 * mocha process (its leading underscore also sorts it ahead alphabetically):
 *   mocha … test/actions/_ctlseed.test.js test/actions/controllerPolicy.test.js
 *
 * Why: contract fee validation needs a fresh {COIN}/USD snapshot for EVERY
 * DEPLOY/EXECUTE, but the in-suite auto-seed (nativeFeeHelper.seedGlobalPrices,
 * non-force) is a no-op when a stale snapshot already exists, and a persistent
 * regtest stack's last seed expires after 1800s of block-time. Then every guard
 * contract DEPLOY indexes "invalid: no current oracle price for {COIN}/USD".
 * (Known harness flake; see claude/reports/launch/test-campaign/smart-contracts.md.)
 *
 * Anchoring: priceSnapshotHelper.usableSeedAnchors(). This preamble used to seed
 * max(tip, now) + 7200 on the theory that the staleness guard is one-sided, so
 * future-dating bought headroom. That stopped being true when H-3 landed: on every
 * chain but BTC, getLatestPrice SELECTS with `block_timestamp <= <block time>`, so
 * a future-dated row is not fresh for longer, it is invisible, and this preamble
 * silently seeded nothing on exactly the LTC/DOGE fee chains it exists to unblock
 * (measured on LTC regtest 2026-07-28, ). Headroom now comes from re-seeding
 * as the chain advances, which is what nativeFeeHelper does per SEED_REFRESH_MS.
 ********************************************************************/

const priceSnapshotHelper = require('../helpers/priceSnapshotHelper')
const { BOOTSTRAP_XCHAIN_USD, NO_PRICE_SEED } = require('../helpers/xchainPriceConstants')

// One round per (pair, anchor). Spelled out as file-local consts, and passed to
// seedSnapshot as `roundNumber: <const>`, because the  coverage guard walks
// this file for that exact shape to prove every round it writes is one
// clearSeedSentinels can retract. An indirection here (rounds[i]) reads fine and
// silently drops the file from that guard.
const CHAIN_ROUND_COIN   = 990001
const CHAIN_ROUND_XCHAIN = 990002
const WALL_ROUND_COIN    = 990011
const WALL_ROUND_XCHAIN  = 990012

describe('_ctlseed: force-seed fresh oracle prices (venue preamble)', function () {
    this.timeout(0)

    it('seeds fresh finalized COIN/USD + XCHAIN/USD inside the usable anchor window', async function () {
        //  step 8: this preamble CLEARS the pair and re-seeds it, which on a
        // venue whose hub publishes prices would delete real finalized rounds and
        // shadow the rest. Hard-skip there.
        if (NO_PRICE_SEED) {
            console.log('   XCHAIN_E2E_NO_PRICE_SEED=1; venue publishes its own prices, not seeding')
            this.skip()
            return
        }
        if (!(await priceSnapshotHelper.isAvailable())) {
            console.log('   price_snapshots not reachable; skipping seed (non-fee venue)')
            this.skip()
            return
        }
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
        for (const s of seeds) {
            const blockTimestamp = anchors[s.anchor]
            if (blockTimestamp === undefined) continue
            await priceSnapshotHelper.seedSnapshot({
                coinPair:       s.coinPair,
                price:          s.price,
                roundNumber:    s.roundNumber,
                blockTimestamp: blockTimestamp,
            })
            console.log(`   seeded ${s.coinPair}=${s.price} @ block_timestamp ${blockTimestamp} `
                + `round ${s.roundNumber} (tip=${chainTime} now=${wallTime})`)
        }
    })
})
