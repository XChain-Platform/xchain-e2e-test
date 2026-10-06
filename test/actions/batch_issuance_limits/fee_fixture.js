// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//

const assert = require('assert')
const nativeFeeHelper = require('../../helpers/nativeFeeHelper')
const priceSnapshotHelper = require('../../helpers/priceSnapshotHelper')
const { BOOTSTRAP_XCHAIN_USD } = require('../../helpers/xchainPriceConstants')
const { state, q, chainTipTime } = require('./shared')

// Fallback native-fee fixture for A4/A5, used ONLY when the suite's standard pair
// would size one command's worth of fee below the chain's dust threshold (which is
// the LTC/DOGE case; see the header). {COIN}/USD is the free parameter, XCHAIN/USD is
// not (the seed guard pins it to the shared bootstrap constant).
const FEE_CASE_COIN_USD     = '1000.00000000'
const FEE_CASE_ROUND_XCHAIN = 997710001
const FEE_CASE_ROUND_COIN   = 997710002

// Per-chain dust threshold in satoshis (xchain-indexer/src/coins/<COIN>.js net).
const DUST_SATS = { BTC: 546, LTC: 5460, DOGE: 100000 }

// The price pair the indexer will actually value a fee against: highest round wins
// (db.getLatestPrice orders by round_number DESC), which is what every seed site in
// this repo relies on.
async function effectivePrices(){
    const rows = await q(`SELECT coin_pair, price, round_number, block_timestamp
                            FROM price_snapshots
                           WHERE coin_pair IN ('XCHAIN/USD', ?) AND status = 'finalized'
                           ORDER BY round_number DESC`, [COIN_CODE + '/USD'])
    const pick = pair => rows.find(r => r.coin_pair === pair)
    return { xchain: pick('XCHAIN/USD'), coin: pick(COIN_CODE + '/USD') }
}

// Size the native-fee arithmetic for one A4/A5 case, and re-price the pair ONLY if
// the standard fixture would make one command's worth of fee an unspendable dust
// output (LTC's threshold is 5460 satoshis, DOGE's 100000; one child ISSUE at the
// standard pair is 1000). Leaving the shared pair alone wherever it already works
// keeps the blast radius off other suites sharing the venue.
//
// seedGlobalPrices(true) first is not decoration: it resets nativeFeeHelper's own
// throttle, so the per-transaction refresh transactionHelper performs while building
// the batch is a no-op and cannot clearPair() this fixture out from under the case.
async function prepareFeeFixture(perCommandXchain){
    await nativeFeeHelper.seedGlobalPrices(true)
    let prices = await effectivePrices()
    assert(prices.xchain && prices.coin,
        'no finalized XCHAIN/USD + ' + COIN_CODE + '/USD snapshots to price a native fee against')
    let satsPerXchain = Math.round(Number(prices.xchain.price) / Number(prices.coin.price) * 1e8)
    const dust = DUST_SATS[COIN_CODE] || 546

    if (Math.round(perCommandXchain * satsPerXchain) < dust * 2){
        const chainTime = await chainTipTime()
        await priceSnapshotHelper.clearPair('XCHAIN/USD')
        await priceSnapshotHelper.clearPair(COIN_CODE + '/USD')
        await priceSnapshotHelper.seedSnapshot({
            coinPair: 'XCHAIN/USD', price: BOOTSTRAP_XCHAIN_USD,
            blockTimestamp: chainTime, roundNumber: FEE_CASE_ROUND_XCHAIN })
        await priceSnapshotHelper.seedSnapshot({
            coinPair: COIN_CODE + '/USD', price: FEE_CASE_COIN_USD,
            blockTimestamp: chainTime, roundNumber: FEE_CASE_ROUND_COIN })
        prices = await effectivePrices()
        satsPerXchain = Math.round(Number(prices.xchain.price) / Number(prices.coin.price) * 1e8)
        state.FEE_CASE_REPRICED = true
        console.log('fee fixture RE-PRICED (one command would have been dust): ' +
            COIN_CODE + '/USD=' + FEE_CASE_COIN_USD + ' anchored at chain_time=' + chainTime)
    }

    state.SATS_PER_XCHAIN = satsPerXchain
    const perCommandSats = Math.round(perCommandXchain * satsPerXchain)
    assert(perCommandSats >= dust,
        'one command of fee is ' + perCommandSats + ' sats, under the ' + COIN_CODE +
        ' dust threshold of ' + dust + '; the exact-size output could not be relayed')
    console.log('fee fixture: XCHAIN/USD=' + prices.xchain.price + ' ' + COIN_CODE + '/USD=' +
        prices.coin.price + ' -> ' + satsPerXchain + ' sats per XCHAIN, ' +
        perCommandSats + ' sats per command')
    return perCommandSats
}

// Undo prepareFeeFixture's re-price for whatever runs next. seedGlobalPrices alone
// cannot do it: the FEE_CASE round numbers outrank every seed round, and
// getLatestPrice picks by round_number DESC, so until the FEE_CASE rows age past
// the staleness window they keep pricing every OTHER test's flat-fee actions
// against the re-priced pair's much larger expectation. Deleting the pairs first
// is what actually restores the shared fixture.
async function restoreFeeFixture(){
    if (state.FEE_CASE_REPRICED){
        await priceSnapshotHelper.clearPair('XCHAIN/USD')
        await priceSnapshotHelper.clearPair(COIN_CODE + '/USD')
        state.FEE_CASE_REPRICED = false
    }
    await nativeFeeHelper.seedGlobalPrices(true)
}

function feeOutput(sats){
    return [{ address: state.FEE_DEST, value: sats }]
}

// A rejected fee-pool draw reports itself either as an exhausted pool or as a short
// one, depending on whether the remainder is exactly zero or merely below the band.
// Both are the invariant under test; anything else is not.
const POOL_EXHAUSTED = /^invalid: (fee output has zero value|insufficient native coin fee)/

module.exports = { effectivePrices, prepareFeeFixture, restoreFeeFixture, feeOutput, POOL_EXHAUSTED }
