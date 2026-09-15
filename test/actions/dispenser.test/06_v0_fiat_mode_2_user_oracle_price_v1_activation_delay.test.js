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
const oraclePriceHelper = require('../../helpers/oraclePriceHelper')
const requireRow = require('../../helpers/requireRow')

const FIAT_DELAY = 'CAD'   // publish-activation delay

async function createActivationDelayDispenser() {
    let dispenserAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.DELAY", COIN, NETWORK, null, "legacy", 0, 1)
    let buyerAddr     = await cryptoHelper.getNewFundedAddress("DISPENSER.DELAY.BUYER", COIN, NETWORK, null, "legacy", 0, 1)
    let oracleAddr    = await cryptoHelper.getNewFundedAddress("DISPENSER.DELAY.SRC", COIN, NETWORK, null, "legacy", 0, 1)
    let dispenserAddress = dispenserAddr["address"]
    let buyerAddress     = buyerAddr["address"]
    let oracleAddress    = oracleAddr["address"]
    let tick = "DISPDLY"+dispenserAddress.substring(dispenserAddress.length-8)

    await issueHelper.sendIssueV0(dispenserAddr, tick, 200, 200, 0, "Update delay test", 200)

    let pair        = COIN_CODE + "/" + FIAT_DELAY
    let coinPrice   = 50000
    let oldPrice    = 100     // in effect now
    let newPrice    = 10      // the "update": 10x cheaper, effective in 2h
    let chainNow    = await priceSnapshotHelper.latestBlockTime()
    let expiration  = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
    let effectiveAt = chainNow - (2 * 3600)

    await priceSnapshotHelper.clearPair(pair)
    await priceSnapshotHelper.seedSnapshot({
        coinPair: pair, price: coinPrice.toFixed(8),
        blockTimestamp: effectiveAt - 120, roundNumber: 999000006
    })
    await oraclePriceHelper.clearQuotes({
        sourceAddress: oracleAddress, coin: COIN_CODE, tick: tick, fiat: FIAT_DELAY
    })
    await oraclePriceHelper.seedQuote({
        sourceAddress: oracleAddress, sourceChain: COIN_CODE,
        coin: COIN_CODE, tick: tick, fiat: FIAT_DELAY,
        value: oldPrice.toFixed(8), fee: '0',
        effectiveAt: effectiveAt, actionIndex: 999000006
    })
    // The update, published "now" and therefore effective 2h from now. It is
    // the NEWEST row for this feed, so a matcher that ignored effective_at
    // would select it first and credit 10x too much.
    await oraclePriceHelper.seedQuote({
        sourceAddress: oracleAddress, sourceChain: COIN_CODE,
        coin: COIN_CODE, tick: tick, fiat: FIAT_DELAY,
        value: newPrice.toFixed(8), fee: '0',
        effectiveAt: chainNow + (2 * 3600), actionIndex: 999000007
    })

    let dispenserResult = await dispenserHelper.sendDispenserV0(
        dispenserAddr, COIN_CODE, tick, 1, 100,
        COIN_CODE, null, 0, dispenserAddr["address"],
        FIAT_DELAY, null, oracleAddress, expiration,
        null, null, 'FIAT update-delay dispenser'
    )
    return { buyerAddr, buyerAddress, dispenserAddress, dispenserResult, tick }
}

async function settleAtActivePrice(scenario) {
    // At the OLD price:  (0.011 * 50000) / 100 = 5.5  -> 5 tokens
    // At the NEW price:  (0.011 * 50000) / 10  = 55   -> 55 tokens
    // Escrow is 100, so 55 would fit: a wrong verdict shows up as a credit,
    // not as a capacity clamp.
    let paySats = 1100000
    let payTx = await transactionHelper.createSimpleTransaction(
        scenario.buyerAddr, scenario.dispenserAddress, paySats
    )
    let dispenseRow = requireRow(await indexerDatabase.waitForDispense({
        txHash: payTx, source: scenario.buyerAddress, giveTick: scenario.tick, status: "valid"
    }, 60000), 'FIAT dispense')
    return dispenseRow
}

describe('DISPENSER', () => {

    describe('v0 - FIAT (Mode 2: user oracle, PRICE v1)', () => {
        it('should settle at the price in effect, never at a newer quote whose effective time has not arrived', async function() {
            // The anti-front-running rule end to end (§5.4): every PRICE v1 publish is
            // effective block_time + 86400, so an oracle operator who sees a payment
            // arrive cannot rush a new price out to change the rate under it. Both
            // matchers also cap their reads at the processing block's own time, so a
            // not-yet-effective quote is invisible by construction.
            //
            // Driven by seeding the "update" with a FUTURE effective_at, which is
            // exactly the state the hub's unconditional +86400 produces the moment an
            // update is published; no mock-time driver is needed to reach it.
            if (!(await priceSnapshotHelper.isAvailable()) || !(await oraclePriceHelper.isAvailable())) {
                console.log('Price tables not reachable; skipping the update-delay test')
                this.skip()
                return
            }

            let scenario = await createActivationDelayDispenser()
            let dispenserResult = scenario.dispenserResult
            assert(dispenserResult.dispenser, "dispenser should be created against the in-effect quote")

            let dispenseRow = await settleAtActivePrice(scenario)
            assert(dispenseRow, "the payment should settle against the quote already in effect")

            let credit = await indexerDatabase.waitForCredit({
                address: scenario.buyerAddress, tick: scenario.tick, amount: "5"
            }, 30000)
            assert(credit, "must credit 5 (old price); 55 would mean the not-yet-effective update priced it")
        })
    })

})
