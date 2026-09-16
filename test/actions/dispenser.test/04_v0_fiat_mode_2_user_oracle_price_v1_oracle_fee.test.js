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
const issueHelper = require('../../helpers/issueHelper')
const dispenserHelper = require('../../helpers/dispenserHelper')
const priceSnapshotHelper = require('../../helpers/priceSnapshotHelper')
const oraclePriceHelper = require('../../helpers/oraclePriceHelper')

const FIAT_OFEE = 'JPY'   // oracle usage fee

async function createUnpaidOracleFeeScenario() {
    let dispenserAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.OFEE", COIN, NETWORK, null, "legacy", 0, 1)
    let oracleAddr    = await cryptoHelper.getNewFundedAddress("DISPENSER.OFEE.SRC", COIN, NETWORK, null, "legacy", 0, 1)
    let dispenserAddress = dispenserAddr["address"]
    let oracleAddress    = oracleAddr["address"]
    let tick = "DISPOFEE"+dispenserAddress.substring(dispenserAddress.length-8)

    await issueHelper.sendIssueV0(dispenserAddr, tick, 1000, 1000, 0, "Oracle fee test", 1000)

    let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
    let chainNow   = await priceSnapshotHelper.latestBlockTime()
    let tokenPrice = 0.05      // oracle: 1 token = $0.05
    let feeFrac    = 0.01      // oracle charges 1%
    let escrow     = 1000

    // The below-dust waiver in quoteOracleFee is consensus: an expected fee
    // under the chain's dust threshold requires NO output at all, so the
    // coin price must keep one fee's worth of coin ABOVE dust on THIS venue
    // or the rejection leg tests nothing (at a flat $50,000 the $5 fee is
    // 1000 sats, which DOGE's 100000-sat dust threshold waives entirely and
    // the no-output create is rightly valid). Re-price only where needed so
    // the BTC numbers stay unchanged.
    const DUST_SATS = { BTC: 546, LTC: 5460, DOGE: 100000 }
    const dustSats  = DUST_SATS[COIN_CODE] || 546
    let coinPrice   = 50000    // validator: 1 coin = $50,000
    let feeUsd      = feeFrac * tokenPrice * escrow
    if (Math.round(feeUsd / coinPrice * 1e8) < Math.ceil(dustSats * 1.5))
        coinPrice = Math.max(1, Math.floor(feeUsd * 1e8 / (4 * dustSats)))

    await priceSnapshotHelper.clearPair(COIN_CODE + "/" + FIAT_OFEE)
    await priceSnapshotHelper.seedSnapshot({
        coinPair: COIN_CODE + "/" + FIAT_OFEE, price: coinPrice.toFixed(8),
        blockTimestamp: chainNow - 120, roundNumber: 999000003
    })
    await oraclePriceHelper.clearQuotes({
        sourceAddress: oracleAddress, coin: COIN_CODE, tick: tick, fiat: FIAT_OFEE
    })
    await oraclePriceHelper.seedQuote({
        sourceAddress: oracleAddress, sourceChain: COIN_CODE,
        coin: COIN_CODE, tick: tick, fiat: FIAT_OFEE,
        value: tokenPrice.toFixed(8), fee: String(feeFrac),
        effectiveAt: chainNow - 60, actionIndex: 999000003
    })

    // fee = FEE x (oracle_price x GIVE_ESCROW) / coin_price
    let expectedFee  = (feeFrac * (tokenPrice * escrow)) / coinPrice   // 0.00001
    let expectedSats = Math.round(expectedFee * 1e8)                   // 1000

    // 1. No output: the create must be rejected.
    let noPay = await dispenserHelper.sendDispenserV0(
        dispenserAddr, COIN_CODE, tick, 1, escrow,
        COIN_CODE, null, 0, dispenserAddr["address"],
        FIAT_OFEE, null, oracleAddress, expiration,
        null, null, 'oracle fee unpaid', null, [],
        'invalid: ORACLE_ADDRESS (missing oracle fee output)'
    )
    return { dispenserAddr, escrow, expectedSats, expiration, noPay, oracleAddress, tick }
}

async function payOracleFee(scenario) {
    // 2. Paying the oracle: the create must be accepted.
    return dispenserHelper.sendDispenserV0(
        scenario.dispenserAddr, COIN_CODE, scenario.tick, 1, scenario.escrow,
        COIN_CODE, null, 0, scenario.dispenserAddr["address"],
        FIAT_OFEE, null, scenario.oracleAddress, scenario.expiration,
        null, null, 'oracle fee paid', null,
        [{ address: scenario.oracleAddress, value: scenario.expectedSats }]
    )
}

describe('DISPENSER', () => {

    describe('v0 - FIAT (Mode 2: user oracle, PRICE v1)', () => {
        it('should reject a Mode 2 create with no oracle fee output, and accept one that pays', async function() {
            // Counterparty parity: when the referenced oracle charges a FEE, the
            // address OPENING the dispenser must pay it up front as a real native-coin
            // output. This is the leg that cannot be proven by unit tests: it needs the
            // encoder to actually place the output and the indexer to actually see it in
            // TX_OUTPUTS.
            // This test guards the decoder gap it proves closed: without the fix below,
            // XChainDecoder.js persists an output to transaction_outputs only when it pays
            // the protocol FEE_DESTINATION (or the tx is a COINPAY), so an output paying a
            // dispenser's ORACLE_ADDRESS never reaches the indexer's data['TX_OUTPUTS'] and
            // the paying create is rejected exactly like the non-paying one. The decoder
            // reads ORACLE_ADDRESS out of the DISPENSER payload it already parses and
            // captures any output paying it (genesis-on for regtest/testnet; mainnet rides
            // the FIX_OUTPUT_FANOUT flag-day). The SDK does not compact ORACLE_ADDRESS to
            // ^<id>, which the decoder cannot resolve.
            if (!(await priceSnapshotHelper.isAvailable()) || !(await oraclePriceHelper.isAvailable())) {
                console.log('Price tables not reachable; skipping oracle-fee test')
                this.skip()
                return
            }

            let scenario = await createUnpaidOracleFeeScenario()
            let noPay = scenario.noPay
            assert(noPay.dispenser, "the attempt should still be recorded")
            assert.strictEqual(noPay.dispenser.status, 'invalid: ORACLE_ADDRESS (missing oracle fee output)',
                "a Mode 2 create must be rejected when the oracle fee output is absent")

            let paid = await payOracleFee(scenario)
            assert(paid.dispenser, "the paying create should exist")
            assert.strictEqual(paid.dispenser.status, 'valid',
                "a Mode 2 create paying the oracle fee must be accepted")
        })
    })

})
