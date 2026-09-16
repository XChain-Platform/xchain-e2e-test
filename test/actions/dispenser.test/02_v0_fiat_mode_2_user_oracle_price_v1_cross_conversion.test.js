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

const FIAT_MODE2 = 'GBP'   // user-oracle cross-conversion

async function createCrossConversionDispenser() {
    let dispenserAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.ORACLE", COIN, NETWORK, null, "legacy", 0, 1)
    let buyerAddr     = await cryptoHelper.getNewFundedAddress("DISPENSER.ORACLE.BUYER", COIN, NETWORK, null, "legacy", 0, 1)
    let oracleAddr    = await cryptoHelper.getNewFundedAddress("DISPENSER.ORACLE.SRC", COIN, NETWORK, null, "legacy", 0, 1)
    let dispenserAddress = dispenserAddr["address"]
    let buyerAddress     = buyerAddr["address"]
    let oracleAddress    = oracleAddr["address"]
    let tick = "DISPORCL"+dispenserAddress.substring(dispenserAddress.length-8)

    await issueHelper.sendIssueV0(dispenserAddr, tick, 100, 100, 0, "Oracle dispenser test", 100)

    let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

    // Seed both legs BEFORE creating the dispenser. Order matters: a Mode 2
    // create is rejected unless its oracle already has an effective
    // price, so seeding afterwards makes the create invalid. Anchored to the
    // CHAIN clock, and the validator snapshot must be at or before the oracle
    // quote's effective_at because the matcher fetches the coin price as of the
    // QUOTE's effective time, not as of the payment block.
    let pair        = COIN_CODE + "/" + FIAT_MODE2
    let coinPrice   = 50000     // 1 coin = 50,000 fiat  (validator)
    let tokenPrice  = 100       // 1 token = 100 fiat    (user oracle)
    let chainNow    = await priceSnapshotHelper.latestBlockTime()

    await priceSnapshotHelper.clearPair(pair)
    await priceSnapshotHelper.seedSnapshot({
        coinPair: pair, price: coinPrice.toFixed(8),
        blockTimestamp: chainNow - 120, roundNumber: 999000002
    })
    await oraclePriceHelper.clearQuotes({
        sourceAddress: oracleAddress, coin: COIN_CODE, tick: tick, fiat: FIAT_MODE2
    })
    await oraclePriceHelper.seedQuote({
        sourceAddress: oracleAddress, sourceChain: COIN_CODE,
        coin: COIN_CODE, tick: tick, fiat: FIAT_MODE2,
        value: tokenPrice.toFixed(8), fee: '0',
        effectiveAt: chainNow - 60, actionIndex: 999000002
    })

    // Now the oracle has an effective price, so the create is accepted.
    let dispenserResult = await dispenserHelper.sendDispenserV0(
        dispenserAddr, COIN_CODE, tick, 1, 50,
        COIN_CODE, null, 0, dispenserAddr["address"],
        FIAT_MODE2, null, oracleAddress, expiration,
        null, null, 'FIAT Mode 2 oracle dispenser'
    )
    return { buyerAddr, buyerAddress, coinPrice, dispenserAddress, dispenserResult, tick, tokenPrice }
}

async function settleCrossConversion(scenario) {
    // Buyer pays 0.011 coin:
    //   tokens = (0.011 * 50000) / 100 = 5.5 => floor => 5
    let paySats = 1100000
    let txHash = await transactionHelper.createSimpleTransaction(
        scenario.buyerAddr, scenario.dispenserAddress, paySats
    )

    let coinAmount     = paySats / 1e8                                       // 0.011
    let expectedUnits  = Math.floor((coinAmount * scenario.coinPrice) / scenario.tokenPrice)   // 5
    let expectedCredit = String(expectedUnits)                               // GIVE_AMOUNT = 1

    console.log("Waiting for Mode 2 FIAT DISPENSE in the database (txHash: "+txHash+")...")
    let dispenseRow = requireRow(await indexerDatabase.waitForDispense({
        txHash: txHash, source: scenario.buyerAddress,
        giveTick: scenario.tick, status: "valid"
    }, 60000), 'FIAT dispense')
    return { dispenseRow, expectedCredit }
}

describe('DISPENSER', () => {

    describe('v0 - FIAT (Mode 2: user oracle, PRICE v1)', () => {
        it('should dispense priced from a user oracle quote cross-converted via the validator snapshot', async function() {
            // Mode 2 sets ORACLE_ADDRESS and leaves FIAT_AMOUNT empty: the user
            // oracle prices the TOKEN in fiat and the validator snapshot prices
            // the COIN in the same fiat, so the two combine to a coin->token
            // rate (reverseOraclePriceMatch). This is the only settlement path
            // that reads BOTH price tables, and until now nothing drove it on a
            // live stack.
            if (!(await priceSnapshotHelper.isAvailable()) || !(await oraclePriceHelper.isAvailable())) {
                console.log('Price tables not reachable; skipping Mode 2 FIAT dispenser test')
                this.skip()
                return
            }

            let scenario = await createCrossConversionDispenser()
            let dispenserResult = scenario.dispenserResult
            assert(dispenserResult.dispenser, "Mode 2 FIAT dispenser should be created")

            let settlement = await settleCrossConversion(scenario)
            let dispenseRow = settlement.dispenseRow
            assert(dispenseRow, "Mode 2 FIAT dispense should exist in DB and be valid")

            let expectedCredit = settlement.expectedCredit
            let credit = await indexerDatabase.waitForCredit({
                address: scenario.buyerAddress,
                tick: scenario.tick,
                amount: expectedCredit
            }, 30000)
            assert(credit, "Buyer should be credited "+expectedCredit+" tokens (Mode 2 oracle cross-conversion)")
        })
    })

})
