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

const FIAT_WINDOW = 'CHF'   // 24h window distance

async function createWindowDispenser() {
    let dispenserAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.WINDOW", COIN, NETWORK, null, "legacy", 0, 1)
    let buyerAddr     = await cryptoHelper.getNewFundedAddress("DISPENSER.WINDOW.BUYER", COIN, NETWORK, null, "legacy", 0, 1)
    let oracleAddr    = await cryptoHelper.getNewFundedAddress("DISPENSER.WINDOW.SRC", COIN, NETWORK, null, "legacy", 0, 1)
    let dispenserAddress = dispenserAddr["address"]
    let buyerAddress     = buyerAddr["address"]
    let oracleAddress    = oracleAddr["address"]
    let tick = "DISPWIN"+dispenserAddress.substring(dispenserAddress.length-8)

    await issueHelper.sendIssueV0(dispenserAddr, tick, 200, 200, 0, "Window distance test", 200)

    let pair       = COIN_CODE + "/" + FIAT_WINDOW
    let coinPrice  = 50000
    let tokenPrice = 100
    let chainNow   = await priceSnapshotHelper.latestBlockTime()
    let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

    // Quote 20h old: inside the 24h window with 4h of margin, so block-time
    // drift while the suite runs cannot flip the verdict.
    let inWindowAt = chainNow - (20 * 3600)
    await priceSnapshotHelper.clearPair(pair)
    await priceSnapshotHelper.seedSnapshot({
        coinPair: pair, price: coinPrice.toFixed(8),
        blockTimestamp: inWindowAt - 120, roundNumber: 999000004
    })
    await oraclePriceHelper.clearQuotes({
        sourceAddress: oracleAddress, coin: COIN_CODE, tick: tick, fiat: FIAT_WINDOW
    })
    await oraclePriceHelper.seedQuote({
        sourceAddress: oracleAddress, sourceChain: COIN_CODE,
        coin: COIN_CODE, tick: tick, fiat: FIAT_WINDOW,
        value: tokenPrice.toFixed(8), fee: '0',
        effectiveAt: inWindowAt, actionIndex: 999000004
    })

    let dispenserResult = await dispenserHelper.sendDispenserV0(
        dispenserAddr, COIN_CODE, tick, 1, 100,
        COIN_CODE, null, 0, dispenserAddr["address"],
        FIAT_WINDOW, null, oracleAddress, expiration,
        null, null, 'FIAT window-distance dispenser'
    )
    return { buyerAddr, buyerAddress, chainNow, coinPrice, dispenserAddress, dispenserResult, oracleAddress, pair, paySats: 1100000, tick, tokenPrice }
}

async function settleInsideWindow(scenario) {
    // tokens = (0.011 * 50000) / 100 = 5.5 -> floor -> 5
    let payTx = await transactionHelper.createSimpleTransaction(
        scenario.buyerAddr, scenario.dispenserAddress, scenario.paySats
    )
    let dispenseRow = requireRow(await indexerDatabase.waitForDispense({
        txHash: payTx, source: scenario.buyerAddress, giveTick: scenario.tick, status: "valid"
    }, 60000), 'FIAT dispense')
    return dispenseRow
}

async function settleOutsideWindow(scenario) {
    // Now push the ONLY quote past the window (25h back, an hour beyond the
    // 24h bound) and seed a contemporaneous validator snapshot for it, so the
    // refusal can only be the window bound and not a missing coin price.
    let pastWindowAt = scenario.chainNow - (25 * 3600)
    await priceSnapshotHelper.seedSnapshot({
        coinPair: scenario.pair, price: scenario.coinPrice.toFixed(8),
        blockTimestamp: pastWindowAt - 120, roundNumber: 999000005
    })
    await oraclePriceHelper.clearQuotes({
        sourceAddress: scenario.oracleAddress, coin: COIN_CODE, tick: scenario.tick, fiat: FIAT_WINDOW
    })
    await oraclePriceHelper.seedQuote({
        sourceAddress: scenario.oracleAddress, sourceChain: COIN_CODE,
        coin: COIN_CODE, tick: scenario.tick, fiat: FIAT_WINDOW,
        value: scenario.tokenPrice.toFixed(8), fee: '0',
        effectiveAt: pastWindowAt, actionIndex: 999000005
    })

    let stalePayTx = await transactionHelper.createSimpleTransaction(
        scenario.buyerAddr, scenario.dispenserAddress, scenario.paySats
    )
    return indexerDatabase.waitForDispense({
        txHash: stalePayTx, source: scenario.buyerAddress, giveTick: scenario.tick,
        status: "invalid: no matching oracle price"
    }, 60000)
}

describe('DISPENSER', () => {

    describe('v0 - FIAT (Mode 2: user oracle, PRICE v1)', () => {
        it('should settle a payment confirming ~20h after the quote, and refuse one past the 24h window', async function() {
            // The 24-hour FIAT_DISPENSER_PRICE_WINDOW is what makes a bare payment
            // survive congestion: the buyer decided how much to send against a price
            // that may be most of a day old by the time the payment confirms. Every
            // other live test seeds a quote seconds old, so the window itself has only
            // ever been exercised at zero distance.
            //
            // Expressed by BACK-DATING effective_at rather than by advancing chain time
            // with a mock-time driver: reverse matching walks back from the payment
            // block's own time, so a quote effective 20h earlier and a payment confirming
            // now IS the long-gap case, deterministically and in one block.
            if (!(await priceSnapshotHelper.isAvailable()) || !(await oraclePriceHelper.isAvailable())) {
                console.log('Price tables not reachable; skipping the window-distance test')
                this.skip()
                return
            }

            let scenario = await createWindowDispenser()
            let dispenserResult = scenario.dispenserResult
            assert(dispenserResult.dispenser, "dispenser should be created against the 20h-old quote")

            let dispenseRow = await settleInsideWindow(scenario)
            assert(dispenseRow, "a payment 20h after the quote must still settle inside the window")

            let credit = await indexerDatabase.waitForCredit({
                address: scenario.buyerAddress, tick: scenario.tick, amount: "5"
            }, 30000)
            assert(credit, "the 20h-old quote must price the dispense (5 tokens)")

            let staleRow = await settleOutsideWindow(scenario)
            assert(staleRow, "a quote older than the 24h window must not price a dispense")
        })
    })

})
