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
 * Anchor to max(latestBlockTime, now) + buffer: the contract-fee staleness guard
 * (getLatestPrice) is one-sided (rejects only too-OLD), so future-dating is safe
 * and buys headroom as the suite mines blocks forward. controllerPolicy exercises
 * no FIAT reverse-price-match, so the 24h-window upper bound is irrelevant here.
 ********************************************************************/

const priceSnapshotHelper = require('../helpers/priceSnapshotHelper')
const { BOOTSTRAP_XCHAIN_USD, NO_PRICE_SEED } = require('../helpers/xchainPriceConstants')

describe('_ctlseed: force-seed fresh oracle prices (venue preamble)', function () {
    this.timeout(0)

    it('seeds fresh finalized BTC/USD + XCHAIN/USD anchored ahead of the chain tip', async function () {
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
        const tip = await priceSnapshotHelper.latestBlockTime()
        const now = Math.floor(Date.now() / 1000)
        // Large forward headroom: the contract-fee staleness guard is one-sided
        // (rejects only too-OLD), so a far-future snapshot never goes stale no matter
        // how fast block_time advances during the run. A stuck-then-unblocked
        // BTC stack can advance block_time by thousands of seconds mid-run. (controllerPolicy
        // exercises no FIAT reverse-price-match, so the 24h-window upper bound is irrelevant.)
        const anchor = Math.max(tip, now) + 7200
        const seeds = [
            { coinPair: `${COIN_CODE}/USD`, price: '100000.00000000', roundNumber: 990001 },
            { coinPair: 'XCHAIN/USD',       price: BOOTSTRAP_XCHAIN_USD,      roundNumber: 990002 },
        ]
        for (const s of seeds) {
            await priceSnapshotHelper.clearPair(s.coinPair)
            await priceSnapshotHelper.seedSnapshot({ ...s, blockTimestamp: anchor })
            console.log(`   seeded ${s.coinPair}=${s.price} @ block_timestamp ${anchor} (tip=${tip} now=${now})`)
        }
    })
})
