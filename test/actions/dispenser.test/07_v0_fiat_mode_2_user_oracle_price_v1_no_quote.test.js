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

const FIAT_NOQ = 'AUD'   // retracted quote

async function createNoQuoteDispenser() {
    let dispenserAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.ORACLE.NQ", COIN, NETWORK, null, "legacy", 0, 1)
    let buyerAddr     = await cryptoHelper.getNewFundedAddress("DISPENSER.ORACLE.NQ.BUYER", COIN, NETWORK, null, "legacy", 0, 1)
    let oracleAddr    = await cryptoHelper.getNewFundedAddress("DISPENSER.ORACLE.NQ.SRC", COIN, NETWORK, null, "legacy", 0, 1)
    let dispenserAddress = dispenserAddr["address"]
    let buyerAddress     = buyerAddr["address"]
    let tick = "DISPNOQ"+dispenserAddress.substring(dispenserAddress.length-8)

    await issueHelper.sendIssueV0(dispenserAddr, tick, 100, 100, 0, "Oracle dispenser no-quote test", 100)

    let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
    let chainNow   = await priceSnapshotHelper.latestBlockTime()

    // Seed a quote so the create is accepted...
    await oraclePriceHelper.seedQuote({
        sourceAddress: oracleAddr["address"], sourceChain: COIN_CODE,
        coin: COIN_CODE, tick: tick, fiat: FIAT_NOQ,
        value: '100.00000000', fee: '0',
        effectiveAt: chainNow - 60, actionIndex: 999000004
    })

    let dispenserResult = await dispenserHelper.sendDispenserV0(
        dispenserAddr, COIN_CODE, tick, 1, 50,
        COIN_CODE, null, 0, dispenserAddr["address"],
        FIAT_NOQ, null, oracleAddr["address"], expiration,
        null, null, 'FIAT Mode 2 no-quote dispenser'
    )
    return { buyerAddr, buyerAddress, dispenserAddress, dispenserResult, oracleAddr, tick }
}

async function settleWithoutQuote(scenario) {
    // ...then retract it before the buyer pays.
    await oraclePriceHelper.clearQuotes({
        sourceAddress: scenario.oracleAddr["address"], coin: COIN_CODE,
        tick: scenario.tick, fiat: FIAT_NOQ
    })

    let txHash = await transactionHelper.createSimpleTransaction(
        scenario.buyerAddr, scenario.dispenserAddress, 1100000
    )
    return indexerDatabase.waitForDispense({
        txHash: txHash, source: scenario.buyerAddress,
        giveTick: scenario.tick, status: "invalid: no matching oracle price"
    }, 60000)
}

describe('DISPENSER', () => {

    describe('v0 - FIAT (Mode 2: user oracle, PRICE v1)', () => {
        it('should reject a dispense when the user oracle has published nothing in the window', async function() {
            // No quote at settlement time => reverseOraclePriceMatch returns null and
            // the dispense is recorded invalid rather than falling back to any other
            // price source.
            //
            // The quote is seeded and then REMOVED before the payment, rather than never
            // existing: since a Mode 2 create is rejected outright unless its
            // oracle already has an effective price, so a never-priced oracle cannot get
            // as far as a dispense. Removing it afterwards models the reachable case, a
            // source-chain reorg retracting the oracle row out from under a live
            // dispenser.
            if (!(await priceSnapshotHelper.isAvailable()) || !(await oraclePriceHelper.isAvailable())) {
                console.log('Price tables not reachable; skipping Mode 2 no-quote test')
                this.skip()
                return
            }

            let scenario = await createNoQuoteDispenser()
            let dispenserResult = scenario.dispenserResult
            assert(dispenserResult.dispenser, "Mode 2 dispenser should be created")

            let dispenseRow = await settleWithoutQuote(scenario)
            assert(dispenseRow, "dispense should be recorded invalid with no matching oracle price")
        })
    })

})
