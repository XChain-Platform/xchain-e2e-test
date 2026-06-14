// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Native-coin fee injection for the general action suite on LTC/DOGE.
//
// Post-fee-era, the LTC/DOGE indexer REQUIRES a native-coin fee output on
// fee-bearing actions: detectFeePaymentMode (xchain-indexer/src/utility.js)
// returns 'rejected' for LTC/DOGE when a tx carries no output paying the
// configured FEE_DESTINATION, whereas BTC falls back to XCHAIN-gas deduction.
// The general action builder (cryptoHelper -> transactionHelper) is gas-mode
// only, so without a fee output every ISSUE on LTC/DOGE is rejected, the tick
// is never created, and the suite hangs on the resulting TICK-unknown cascade.
//
// validateNativeCoinFee (utility.js) enforces only a LOWER bound — it rejects
// when paidAmount < 0.95 * oracle-expected and never rejects overpayment — and
// this suite seeds (and therefore controls) the oracle prices. So a single flat
// fee output that comfortably clears the min for every action is sufficient; no
// per-action fee computation is needed. BTC is left untouched (gas mode).

const priceSnapshotHelper = require('./priceSnapshotHelper')

const PLACEHOLDER = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'

// Seeded oracle prices. Identical to nativeFeeLive.test.js so the global seed
// here and that suite's inline re-seed never disagree: XCHAIN $1, coin $100,000.
const XCHAIN_USD = '1.00000000'
const COIN_USD   = '100000.00000000'

// Flat native fee output (satoshis). With the prices above, the indexer's
// minAcceptable for an action costing X XCHAIN is 0.95 * X / 100000 coin;
// 50000 sats (0.0005 coin) clears the min for any action up to ~52 XCHAIN —
// far above any e2e action — and matches nativeFeeLive's proven output. It is
// negligible against the ~1-coin fundings cryptoHelper uses.
const FLAT_FEE_SATS = 50000

// Re-seed at most this often. Must stay well under ORACLE_MAX_PRICE_AGE_SECONDS
// (1800s): a >30-minute run would otherwise let the seeded snapshot age out and
// the validator would reject every fee as stale. Re-anchored to the chain clock.
const SEED_REFRESH_MS = 10 * 60 * 1000

// Synthetic round numbers for the seeded snapshots — kept clear of the values
// nativeFeeLive (999200001+) / nativeFeeDispenser use, so the two never collide.
const XCHAIN_ROUND = 888100001
const COIN_ROUND   = 888100002

let _lastSeedMs = 0

// Only LTC/DOGE mandate a native fee output; BTC uses the XCHAIN-gas fallback.
function isFeeChain(){
    return global.COIN_CODE === 'LTC' || global.COIN_CODE === 'DOGE'
}

// Resolve the protocol fee destination the decoder/indexer were configured with.
// Matches the env the container is given (XCHAIN_FEE_DESTINATION_<CODE>_<NET>,
// falling back to FEE_DESTINATION); the XXXX placeholder counts as "unset".
function resolveFeeDestination(){
    const a = process.env['XCHAIN_FEE_DESTINATION_' + global.COIN_CODE + '_' + global.NETWORK.toUpperCase()]
        || process.env.FEE_DESTINATION || null
    return (a && a !== PLACEHOLDER) ? a : null
}

// Seed XCHAIN/USD + {COIN}/USD so the indexer can value native-coin fees.
// No-op on BTC and when the last seed is still fresh (unless force=true).
async function seedGlobalPrices(force){
    if (!isFeeChain()) return
    const now = Date.now()
    if (!force && (now - _lastSeedMs) < SEED_REFRESH_MS) return

    const available = await priceSnapshotHelper.isAvailable()
    if (!available) {
        console.log('nativeFeeHelper: price_snapshots not reachable — skipping price seed')
        return
    }

    // Anchor to the chain clock (not Date.now()): staleness is judged against
    // the processed block's time, and regtest block timestamps drift from wall
    // time under sustained mining. clearPair first so exactly one finalized row
    // exists per pair (no ambiguity for getLatestPrice).
    const blockTimestamp = await priceSnapshotHelper.latestBlockTime()
    await priceSnapshotHelper.clearPair('XCHAIN/USD')
    await priceSnapshotHelper.clearPair(global.COIN_CODE + '/USD')
    await priceSnapshotHelper.seedSnapshot({ coinPair: 'XCHAIN/USD', price: XCHAIN_USD, blockTimestamp, roundNumber: XCHAIN_ROUND })
    await priceSnapshotHelper.seedSnapshot({ coinPair: global.COIN_CODE + '/USD', price: COIN_USD, blockTimestamp, roundNumber: COIN_ROUND })
    _lastSeedMs = now
    console.log('nativeFeeHelper: seeded oracle prices XCHAIN/USD=' + XCHAIN_USD +
        ' ' + global.COIN_CODE + '/USD=' + COIN_USD + ' (block_time=' + blockTimestamp + ')')
}

// The native fee output to attach to an action tx, or null to skip (BTC, no
// FEE_DESTINATION, or price_snapshots unreachable). Refreshes prices first so a
// long run never ages out of the staleness window.
async function getNativeFeeOutput(){
    if (!isFeeChain()) return null
    const feeDest = resolveFeeDestination()
    if (!feeDest) return null
    await seedGlobalPrices(false)
    return { address: feeDest, value: FLAT_FEE_SATS }
}

module.exports = { resolveFeeDestination, seedGlobalPrices, getNativeFeeOutput, FLAT_FEE_SATS }
