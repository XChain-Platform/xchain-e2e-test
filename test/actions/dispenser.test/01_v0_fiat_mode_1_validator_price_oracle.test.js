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
const cryptoHelper = require('../../cryptoHelper')
const transactionHelper = require('../../transactionHelper')
const issueHelper = require('../../helpers/issueHelper')
const dispenserHelper = require('../../helpers/dispenserHelper')
const priceSnapshotHelper = require('../../helpers/priceSnapshotHelper')
const requireRow = require('../../helpers/requireRow')

const FIAT_MODE1 = 'EUR'   // validator-snapshot dispenser

async function createMode1Dispenser() {
    let dispenserAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.FIAT", COIN, NETWORK, null, "legacy", 0, 1)
    let buyerAddr     = await cryptoHelper.getNewFundedAddress("DISPENSER.FIAT.BUYER", COIN, NETWORK, null, "legacy", 0, 1)
    let dispenserAddress = dispenserAddr["address"]
    let buyerAddress     = buyerAddr["address"]
    let tick = "DISPFIAT"+dispenserAddress.substring(dispenserAddress.length-8)

    await issueHelper.sendIssueV0(dispenserAddr, tick, 100, 100, 0, "FIAT dispenser test", 100)

    let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

    // FIAT dispenser: priced at 100.00 (FIAT_MODE1) per 1 token. GET_AMOUNT is
    // ignored for FIAT dispensers (pass 0).
    let dispenserResult = await dispenserHelper.sendDispenserV0(
        dispenserAddr,
        COIN_CODE, tick, 1, 50,
        COIN_CODE, null, 0, dispenserAddr["address"],
        FIAT_MODE1, "100.00", null, expiration,
        null, null, 'FIAT Mode 1 dispenser'
    )
    return { buyerAddr, buyerAddress, dispenserAddress, dispenserResult, tick }
}

async function settleMode1Dispenser(scenario) {
    // Seed a deterministic price: 1 coin = 50000 (FIAT_MODE1).
    //   coin_per_token = FIAT_AMOUNT / price = 100 / 50000 = 0.002 coin
    // Anchor the seed to the CHAIN's clock (latest block_time), 60s in
    // its past: reversePriceMatch bounds on the payment tx's BLOCK_TIME
    // and the staleness cap (ORACLE_MAX_PRICE_AGE_SECONDS = 1800s)
    // measures age vs the processed block; wall-clock seeds raced both
    // rules depending on how far regtest block timestamps drift.
    let pair  = COIN_CODE + "/" + FIAT_MODE1
    let price  = 50000
    let fiatAmount = 100
    await priceSnapshotHelper.clearPair(pair)
    await priceSnapshotHelper.seedSnapshot({
        coinPair: pair,
        price: price.toFixed(8),
        blockTimestamp: (await priceSnapshotHelper.latestBlockTime()) - 60,
        roundNumber: 999000001
    })

    // Buyer pays 0.011 coin (1,100,000 sats):
    //   units = floor(0.011 / 0.002) = floor(5.5) = 5 tokens
    let paySats = 1100000
    let txHash = await transactionHelper.createSimpleTransaction(
        scenario.buyerAddr, scenario.dispenserAddress, paySats
    )

    let coinAmount    = paySats / 1e8                 // 0.011
    let coinPerToken  = fiatAmount / price             // 0.002
    let expectedUnits = Math.floor(coinAmount / coinPerToken)  // 5
    let expectedCredit = String(expectedUnits)         // GIVE_AMOUNT = 1, 0 decimals

    console.log("Waiting for FIAT DISPENSE in the database (txHash: "+txHash+")...")
    let dispenseRow = requireRow(await indexerDatabase.waitForDispense({
        txHash: txHash, source: scenario.buyerAddress,
        giveTick: scenario.tick, status: "valid"
    }, 60000), 'FIAT dispense')
    return { dispenseRow, expectedCredit }
}
// Every FIAT case below prices in its OWN fiat, so no two of them, and
// nothing outside this file, ever share a coin_pair.
//
// `price_snapshots` is global fixture state keyed only by coin_pair, and
// {COIN}/USD has three writers that each DELETE the whole pair before reseeding
// it: `_ctlseed.test.js`, the FIAT cases themselves, and
// `nativeFeeHelper.seedGlobalPrices()`. The last one is the dangerous one: it
// runs from getNativeFeeOutput(), which EVERY action tx passes through, and it
// reseeds at a present-day timestamp and a different price (100000, not the
// 50000 these cases assert). So any action tx sent between a case's seed and
// its payment could silently replace that seed.
//
// Its 2-minute throttle is what made this a FLAKE rather than a hard failure:
// run in isolation the reseed fires before the case seeds and stays suppressed
// through it; in a full-file run the earlier cases burn the throttle so the
// boundary lands mid-case.
//
// The Mode 2 cases are the fragile ones, because reverseOraclePriceMatch reads
// the validator price as of the QUOTE's effective_at, not the payment's block
// time: a reseed dated "now" falls outside that window entirely and the dispense
// settles `invalid: no matching oracle price`, i.e. a fixture race that reads
// exactly like a consensus bug. The back-dated cases (20h, 25h) cannot survive
// it at all.
//
// Namespacing by fiat is the whole fix: FIAT_CODE is free to vary across the 12
// configured fiats and nothing else in the tree seeds a non-USD pair.

describe('DISPENSER', () => {
    describe('v0 - FIAT (Mode 1: validator price oracle)', () => {
        it('should dispense priced from a seeded FIAT price snapshot', async function() {
            // Mode 1 derives the coin price from FIAT_AMOUNT and a finalized
            // GET_COIN/FIAT price_snapshots row (24h reverse-match, newest-first).
            // We clear the pair and seed exactly one deterministic row, so the
            // assertion is exact. This assumes the e2e regtest hub is not
            // continuously finalizing live CoinGecko rows for this pair
            // (the planned Slice-1 design: CoinGecko prices are mainnet-live
            // and cannot be asserted exactly).
            if (!(await priceSnapshotHelper.isAvailable())) {
                console.log('Hub DB (price_snapshots) not reachable; skipping FIAT dispenser test')
                this.skip()
                return
            }

            let scenario = await createMode1Dispenser()
            let dispenserResult = scenario.dispenserResult
            assert(dispenserResult.dispenser, "FIAT dispenser should be created")

            let settlement = await settleMode1Dispenser(scenario)
            let dispenseRow = settlement.dispenseRow
            assert(dispenseRow, "FIAT dispense should exist in DB and be valid")

            let expectedCredit = settlement.expectedCredit
            let credit = await indexerDatabase.waitForCredit({
                address: scenario.buyerAddress,
                tick: scenario.tick,
                amount: expectedCredit
            }, 30000)
            assert(credit, "Buyer should be credited "+expectedCredit+" tokens (FIAT Mode 1 reverse-match)")
        })
    })

})
