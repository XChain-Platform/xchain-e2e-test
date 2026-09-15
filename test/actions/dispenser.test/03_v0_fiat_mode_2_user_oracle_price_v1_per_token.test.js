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

const FIAT_PERTOK = 'MXN'   // per-TOKEN oracle pricing at GIVE_AMOUNT > 1

async function createPerTokenDispenser() {
    let dispenserAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.PERTOK", COIN, NETWORK, null, "legacy", 0, 1)
    let buyerAddr     = await cryptoHelper.getNewFundedAddress("DISPENSER.PERTOK.BUYER", COIN, NETWORK, null, "legacy", 0, 1)
    let oracleAddr    = await cryptoHelper.getNewFundedAddress("DISPENSER.PERTOK.SRC", COIN, NETWORK, null, "legacy", 0, 1)
    let dispenserAddress = dispenserAddr["address"]
    let buyerAddress     = buyerAddr["address"]
    let oracleAddress    = oracleAddr["address"]
    let tick = "DISPPTOK"+dispenserAddress.substring(dispenserAddress.length-8)

    await issueHelper.sendIssueV0(dispenserAddr, tick, 100, 100, 0, "Per-token oracle dispenser test", 100)
    let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

    // Same seeding order and clock anchoring as the case above: the
    // validator snapshot must sit at or before the quote's effective_at,
    // and the quote must be effective before the create.
    let pair       = COIN_CODE + "/" + FIAT_PERTOK
    let coinPrice  = 50000      // 1 coin  = 50,000 fiat (validator)
    let tokenPrice = 100        // 1 TOKEN = 100 fiat    (user oracle)
    let giveAmount = 5          // 5 tokens per fill, so a fill costs 500 fiat
    let chainNow   = await priceSnapshotHelper.latestBlockTime()

    await priceSnapshotHelper.clearPair(pair)
    await priceSnapshotHelper.seedSnapshot({
        coinPair: pair, price: coinPrice.toFixed(8),
        blockTimestamp: chainNow - 120, roundNumber: 999000003
    })
    await oraclePriceHelper.clearQuotes({
        sourceAddress: oracleAddress, coin: COIN_CODE, tick: tick, fiat: FIAT_PERTOK
    })
    await oraclePriceHelper.seedQuote({
        sourceAddress: oracleAddress, sourceChain: COIN_CODE,
        coin: COIN_CODE, tick: tick, fiat: FIAT_PERTOK,
        value: tokenPrice.toFixed(8), fee: '0',
        effectiveAt: chainNow - 60, actionIndex: 999000003
    })

    let dispenserResult = await dispenserHelper.sendDispenserV0(
        dispenserAddr, COIN_CODE, tick, giveAmount, 50,
        COIN_CODE, null, 0, dispenserAddr["address"],
        FIAT_PERTOK, null, oracleAddress, expiration,
        null, null, 'FIAT Mode 2 per-token dispenser'
    )
    return { buyerAddr, buyerAddress, coinPrice, dispenserAddress, dispenserResult, giveAmount, tick, tokenPrice }
}

async function preparePerTokenSettlement(scenario) {
    // Buyer pays 0.011 coin = 550 fiat:
    //   tokens = (0.011 * 50000) / 100 = 5.5
    //   fills  = floor(5.5 / 5)        = 1
    //   credit = 1 * 5                 = 5 tokens
    // Under the pre-flag-day reading this same payment credited
    // floor(5.5) * 5 = 25 tokens, i.e. five times as many.
    let paySats = 1100000
    let txHash = await transactionHelper.createSimpleTransaction(
        scenario.buyerAddr, scenario.dispenserAddress, paySats
    )

    let coinAmount     = paySats / 1e8                                  // 0.011
    let tokensAfforded = (coinAmount * scenario.coinPrice) / scenario.tokenPrice          // 5.5
    let expectedFills  = Math.floor(tokensAfforded / scenario.giveAmount)        // 1
    let expectedCredit = String(expectedFills * scenario.giveAmount)             // '5'
    let perFillReading = String(Math.floor(tokensAfforded) * scenario.giveAmount) // '25'

    return { expectedCredit, perFillReading, txHash }
}

async function waitForPerTokenDispense(scenario, txHash) {
    console.log("Waiting for per-token Mode 2 DISPENSE in the database (txHash: "+txHash+")...")
    return indexerDatabase.waitForDispense({
        txHash: txHash, source: scenario.buyerAddress,
        giveTick: scenario.tick, status: "valid"
    }, 60000)
}

describe('DISPENSER', () => {

    describe('v0 - FIAT (Mode 2: user oracle, PRICE v1)', () => {
        it('should price a multi-token fill per TOKEN, not per fill (GIVE_AMOUNT > 1)', async function() {
            // The case every earlier example and test missed. A PRICE v1 oracle
            // publishes the price of one TOKEN, and a dispenser hands out
            // GIVE_AMOUNT tokens at a time, so the payment buys whole FILLS at
            // oracle_price x GIVE_AMOUNT each. At GIVE_AMOUNT 1 both readings give
            // the same number, which is why the case above cannot see the
            // difference and this one can.
            //
            // Without the per-token divide, a GIVE_AMOUNT-5 fill would sell tokens at
            // a fifth of the oracle price while the operator's fee is still computed
            // on the full oracle price a token. Settlement divides by GIVE_AMOUNT
            // (DISPENSER_ORACLE_PER_TOKEN_PRICE, genesis-active on regtest).
            if (!(await priceSnapshotHelper.isAvailable()) || !(await oraclePriceHelper.isAvailable())) {
                console.log('Price tables not reachable; skipping per-token Mode 2 test')
                this.skip()
                return
            }

            let scenario = await createPerTokenDispenser()
            let dispenserResult = scenario.dispenserResult
            assert(dispenserResult.dispenser, "Mode 2 per-token FIAT dispenser should be created")

            let settlement = await preparePerTokenSettlement(scenario)
            let expectedCredit = settlement.expectedCredit
            let perFillReading = settlement.perFillReading
            assert.notStrictEqual(expectedCredit, perFillReading,
                "the fixture must be able to tell the two readings apart")

            let dispenseRow = await waitForPerTokenDispense(scenario, settlement.txHash)
            assert(dispenseRow, "per-token Mode 2 dispense should exist in DB and be valid")

            let credit = await indexerDatabase.waitForCredit({
                address: scenario.buyerAddress,
                tick: scenario.tick,
                amount: expectedCredit
            }, 30000)
            assert(credit, "Buyer should be credited "+expectedCredit+" tokens, not the "+perFillReading+" the per-fill reading gave")
        })
    })

})
