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
const cryptoHelper = require('../cryptoHelper')
const transactionHelper = require('../transactionHelper')
const issueHelper = require('../helpers/issueHelper')
const dispenserHelper = require('../helpers/dispenserHelper')
const priceSnapshotHelper = require('../helpers/priceSnapshotHelper')
const oraclePriceHelper = require('../helpers/oraclePriceHelper')
const gasHelper = require('../helpers/gasHelper')

describe('DISPENSER', () => {
    describe('v0', () => {
        it('should create a DISPENSER Message v0', async () => {
            let dispenserAddressInfo = await cryptoHelper.getNewFundedAddress("DISPENSER.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let dispenserAddress = dispenserAddressInfo["address"]
            let dispenserTick = "DISPENSERv0"+dispenserAddress.substring(dispenserAddress.length-8)

            await issueHelper.sendIssueV0(dispenserAddressInfo, dispenserTick, 100, 100, 0, "Dispenser v0 test", 100)
            // 3-month expiration tips ~2 days past the 90-day free window, so it needs GAS for the fee.
            await gasHelper.ensureGasBalance(dispenserAddressInfo, '100')

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let result = await dispenserHelper.sendDispenserV0(
                dispenserAddressInfo,
                COIN_CODE, dispenserTick, 1, 10,
                COIN_CODE, null, 5, dispenserAddressInfo["address"],
                null, null, null, Math.floor(expirationDate.getTime() / 1000),
                null, null, 'This is a dispenser v0 test'
            )
            assert(result.dispenser, "Dispenser v0 should exist in DB")
        })
    })

    describe('v0 - FRESH non-SOURCE GET_ADDRESS (wallet sub-address model)', () => {
        it('should open on a FRESH non-SOURCE GET_ADDRESS with escrow debiting SOURCE', async () => {
            // Mirrors the xchain-wallet per-account dispenser sub-address model:
            // SOURCE holds the token and signs (escrow debits it); GET_ADDRESS is
            // a brand-new address the dispenser operates on (the wallet's C=2
            // branch). The protocol fresh-address exception permits opening on an
            // unfunded address with no DISPENSER_PREFERENCE pre-config.
            let sourceInfo = await cryptoHelper.getNewFundedAddress("DISPENSER.FRESH.SOURCE", COIN, NETWORK, null, "legacy", 0, 1)
            let sourceAddress = sourceInfo["address"]
            let tick = "DISPFRESH"+sourceAddress.substring(sourceAddress.length-8)

            // Fresh, UNFUNDED, non-SOURCE address (distinct label -> distinct seed).
            let freshGetInfo = await cryptoHelper.getNewAddress("DISPENSER.FRESH.GETADDR", COIN, NETWORK)
            let freshGetAddress = freshGetInfo["address"]
            assert.notStrictEqual(freshGetAddress, sourceAddress, "GET_ADDRESS must differ from SOURCE")

            await issueHelper.sendIssueV0(sourceInfo, tick, 100, 100, 0, "Fresh GET_ADDRESS dispenser", 100)

            // No EXPIRATION (matches the wallet flow, which sets none): stays in
            // the free 90-day window, needs no GAS, and never writes an epoch into
            // the decoder's DATETIME expiration column.
            let result = await dispenserHelper.sendDispenserV0(
                sourceInfo,
                COIN_CODE, tick, 1, 10,
                COIN_CODE, null, 5, freshGetAddress,
                null, null, null, null,
                null, null, 'Fresh non-SOURCE GET_ADDRESS dispenser'
            )
            // waitForDispenser asserts source=SOURCE AND get_address=freshGetAddress
            // with status=valid: proves escrow debited SOURCE while the dispenser
            // lives on the fresh non-SOURCE address.
            assert(result.dispenser, "Dispenser should exist with fresh non-SOURCE GET_ADDRESS")
        })
    })

    describe('dispense', () => {
        it('should dispense a token from a dispenser', async () => {
            let dispenserAddressInfo = await cryptoHelper.getNewFundedAddress("DISPENSER.V0.DISPENSE", COIN, NETWORK, null, "legacy", 0, 1)
            let dispenseAddressInfo = await cryptoHelper.getNewFundedAddress("DISPENSE", COIN, NETWORK, null, "legacy", 0, 1)
            let dispenserAddress = dispenserAddressInfo["address"]
            let dispenserTick = "DISPENSERv0DISPENSE"+dispenserAddress.substring(dispenserAddress.length-8)

            await issueHelper.sendIssueV0(dispenserAddressInfo, dispenserTick, 100, 100, 0, "Dispenser v0 test to dispense", 100)
            await gasHelper.ensureGasBalance(dispenserAddressInfo, '100')

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let dispenserResult = await dispenserHelper.sendDispenserV0(
                dispenserAddressInfo,
                COIN_CODE, dispenserTick, 1, 10,
                COIN_CODE, null, 0.05, dispenserAddressInfo["address"],
                null, null, null, Math.floor(expirationDate.getTime() / 1000),
                null, null, 'This is a dispenser v0 test to dispense'
            )
            assert(dispenserResult.dispenser, "Dispenser should exist in DB")

            let txHash = await transactionHelper.createSimpleTransaction(
                dispenseAddressInfo, dispenserAddress, 5000000
            )

            console.log("Waiting for DISPENSE in the database (txHash: "+txHash+")...")
            let dispenseRow = await indexerDatabase.waitForDispense({
                txHash: txHash,
                source: dispenseAddressInfo["address"],
                giveCoin: COIN_CODE,
                giveTick: dispenserTick,
                giveAmount: 1,
                getCoin: COIN_CODE,
                getAmount: 0.05,
                destination: dispenseAddressInfo["address"],
                status: "valid"
            }, 60000)

            if (!dispenseRow) {
                // Debug: query without filters
                let debugResult = await indexerDatabase.waitForDispense({ txHash: txHash }, 5000)
                console.log("Debug - dispense by txHash only:", debugResult)
                let debugResult2 = await indexerDatabase.waitForDispense({ source: dispenseAddressInfo["address"] }, 5000)
                console.log("Debug - dispense by source only:", debugResult2)
            }
            assert(dispenseRow, "Dispense should exist in DB")
        })
    })

    describe('dispense - balance verification', () => {
        it('should credit recipient and debit dispenser after dispense', async () => {
            let dispenserAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.BAL", COIN, NETWORK, null, "legacy", 0, 1)
            let buyerAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.BAL.BUYER", COIN, NETWORK, null, "legacy", 0, 1)
            let dispenserAddress = dispenserAddr["address"]
            let buyerAddress = buyerAddr["address"]
            let tick = "DISPBALv0"+dispenserAddress.substring(dispenserAddress.length-8)

            // 4 decimal places; 50 units escrowed
            await issueHelper.sendIssueV0(dispenserAddr, tick, 100, 100, 4, "Dispenser balance test", 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            // 2.5000 tokens per 0.001 BTC; buyer sends 0.002 BTC -> 5.0000 tokens
            let dispenserResult = await dispenserHelper.sendDispenserV0(
                dispenserAddr,
                COIN_CODE, tick, "2.5", 50,
                COIN_CODE, null, 0.001, dispenserAddr["address"],
                null, null, null, expiration,
                null, null, 'Balance verification dispenser'
            )
            assert(dispenserResult.dispenser, "Dispenser should be created")

            let txHash = await transactionHelper.createSimpleTransaction(
                buyerAddr, dispenserAddress, 200000
            )

            console.log("Waiting for DISPENSE in the database...")
            let dispenseRow = await indexerDatabase.waitForDispense({
                txHash: txHash,
                source: buyerAddress,
                giveTick: tick,
                status: "valid"
            }, 60000)
            assert(dispenseRow, "Dispense should exist in DB")

            let credit = await indexerDatabase.waitForCredit({
                address: buyerAddress,
                tick: tick,
                amount: "5"
            }, 30000)
            assert(credit, "Buyer should be credited 5 tokens")

            let debit = await indexerDatabase.waitForDebit({
                address: dispenserAddress,
                tick: tick,
                amount: "50"
            }, 30000)
            assert(debit, "Dispenser should have escrowed 50 tokens")
        })
    })

    // . Every FIAT case below prices in its OWN fiat, so no two of them, and
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
    const FIAT_MODE1  = 'EUR'   // validator-snapshot dispenser
    const FIAT_MODE2  = 'GBP'   // user-oracle cross-conversion
    const FIAT_OFEE   = 'JPY'   // oracle usage fee 
    const FIAT_WINDOW = 'CHF'   // 24h window distance
    const FIAT_DELAY  = 'CAD'   // publish-activation delay
    const FIAT_NOQ    = 'AUD'   // retracted quote

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
            assert(dispenserResult.dispenser, "FIAT dispenser should be created")

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
                buyerAddr, dispenserAddress, paySats
            )

            let coinAmount    = paySats / 1e8                 // 0.011
            let coinPerToken  = fiatAmount / price             // 0.002
            let expectedUnits = Math.floor(coinAmount / coinPerToken)  // 5
            let expectedCredit = String(expectedUnits)         // GIVE_AMOUNT = 1, 0 decimals

            console.log("Waiting for FIAT DISPENSE in the database (txHash: "+txHash+")...")
            let dispenseRow = await indexerDatabase.waitForDispense({
                txHash: txHash,
                source: buyerAddress,
                giveTick: tick,
                status: "valid"
            }, 60000)
            assert(dispenseRow, "FIAT dispense should exist in DB and be valid")

            let credit = await indexerDatabase.waitForCredit({
                address: buyerAddress,
                tick: tick,
                amount: expectedCredit
            }, 30000)
            assert(credit, "Buyer should be credited "+expectedCredit+" tokens (FIAT Mode 1 reverse-match)")
        })
    })

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

            let dispenserAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.ORACLE", COIN, NETWORK, null, "legacy", 0, 1)
            let buyerAddr     = await cryptoHelper.getNewFundedAddress("DISPENSER.ORACLE.BUYER", COIN, NETWORK, null, "legacy", 0, 1)
            let oracleAddr    = await cryptoHelper.getNewFundedAddress("DISPENSER.ORACLE.SRC", COIN, NETWORK, null, "legacy", 0, 1)
            let dispenserAddress = dispenserAddr["address"]
            let buyerAddress     = buyerAddr["address"]
            let oracleAddress    = oracleAddr["address"]
            let tick = "DISPORCL"+dispenserAddress.substring(dispenserAddress.length-8)

            await issueHelper.sendIssueV0(dispenserAddr, tick, 100, 100, 0, "Oracle dispenser test", 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            // Seed both legs BEFORE creating the dispenser. Order matters since :
            // a Mode 2 create is rejected unless its oracle already has an effective
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
                coinPair: pair,
                price: coinPrice.toFixed(8),
                blockTimestamp: chainNow - 120,
                roundNumber: 999000002
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
                dispenserAddr,
                COIN_CODE, tick, 1, 50,
                COIN_CODE, null, 0, dispenserAddr["address"],
                FIAT_MODE2, null, oracleAddress, expiration,
                null, null, 'FIAT Mode 2 oracle dispenser'
            )
            assert(dispenserResult.dispenser, "Mode 2 FIAT dispenser should be created")

            // Buyer pays 0.011 coin:
            //   tokens = (0.011 * 50000) / 100 = 5.5 => floor => 5
            let paySats = 1100000
            let txHash = await transactionHelper.createSimpleTransaction(
                buyerAddr, dispenserAddress, paySats
            )

            let coinAmount     = paySats / 1e8                                       // 0.011
            let expectedUnits  = Math.floor((coinAmount * coinPrice) / tokenPrice)   // 5
            let expectedCredit = String(expectedUnits)                               // GIVE_AMOUNT = 1

            console.log("Waiting for Mode 2 FIAT DISPENSE in the database (txHash: "+txHash+")...")
            let dispenseRow = await indexerDatabase.waitForDispense({
                txHash: txHash,
                source: buyerAddress,
                giveTick: tick,
                status: "valid"
            }, 60000)
            assert(dispenseRow, "Mode 2 FIAT dispense should exist in DB and be valid")

            let credit = await indexerDatabase.waitForCredit({
                address: buyerAddress,
                tick: tick,
                amount: expectedCredit
            }, 30000)
            assert(credit, "Buyer should be credited "+expectedCredit+" tokens (Mode 2 oracle cross-conversion)")
        })

        it('should reject a Mode 2 create with no oracle fee output, and accept one that pays', async function() {
            // , Counterparty parity: when the referenced oracle charges a FEE, the
            // address OPENING the dispenser must pay it up front as a real native-coin
            // output. This is the leg that cannot be proven by unit tests: it needs the
            // encoder to actually place the output and the indexer to actually see it in
            // TX_OUTPUTS.
            // This test FOUND the decoder gap it now proves closed: XChainDecoder.js used to
            // persist an output to transaction_outputs only when it paid the protocol
            // FEE_DESTINATION (or the tx was a COINPAY), so an output paying a dispenser's
            // ORACLE_ADDRESS never reached the indexer's data['TX_OUTPUTS'] and the paying
            // create was rejected exactly like the non-paying one. Closed by : the
            // decoder reads ORACLE_ADDRESS out of the DISPENSER payload it already parses
            // and captures any output paying it (genesis-on for regtest/testnet; mainnet
            // rides the FIX_OUTPUT_FANOUT flag-day). The SDK also stopped compacting
            // ORACLE_ADDRESS to ^<id>, which the decoder cannot resolve.
            if (!(await priceSnapshotHelper.isAvailable()) || !(await oraclePriceHelper.isAvailable())) {
                console.log('Price tables not reachable; skipping oracle-fee test')
                this.skip()
                return
            }

            let dispenserAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.OFEE", COIN, NETWORK, null, "legacy", 0, 1)
            let oracleAddr    = await cryptoHelper.getNewFundedAddress("DISPENSER.OFEE.SRC", COIN, NETWORK, null, "legacy", 0, 1)
            let dispenserAddress = dispenserAddr["address"]
            let oracleAddress    = oracleAddr["address"]
            let tick = "DISPOFEE"+dispenserAddress.substring(dispenserAddress.length-8)

            await issueHelper.sendIssueV0(dispenserAddr, tick, 1000, 1000, 0, "Oracle fee test", 1000)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
            let chainNow   = await priceSnapshotHelper.latestBlockTime()
            let coinPrice  = 50000     // validator: 1 coin = $50,000
            let tokenPrice = 0.05      // oracle: 1 token = $0.05
            let feeFrac    = 0.01      // oracle charges 1%
            let escrow     = 1000

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
            assert(noPay.dispenser, "the attempt should still be recorded")
            assert.strictEqual(noPay.dispenser.status, 'invalid: ORACLE_ADDRESS (missing oracle fee output)',
                "a Mode 2 create must be rejected when the oracle fee output is absent")

            // 2. Paying the oracle: the create must be accepted.
            let paid = await dispenserHelper.sendDispenserV0(
                dispenserAddr, COIN_CODE, tick, 1, escrow,
                COIN_CODE, null, 0, dispenserAddr["address"],
                FIAT_OFEE, null, oracleAddress, expiration,
                null, null, 'oracle fee paid', null,
                [{ address: oracleAddress, value: expectedSats }]
            )
            assert(paid.dispenser, "the paying create should exist")
            assert.strictEqual(paid.dispenser.status, 'valid',
                "a Mode 2 create paying the oracle fee must be accepted")
        })

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
            assert(dispenserResult.dispenser, "dispenser should be created against the 20h-old quote")

            // tokens = (0.011 * 50000) / 100 = 5.5 -> floor -> 5
            let paySats = 1100000
            let payTx = await transactionHelper.createSimpleTransaction(buyerAddr, dispenserAddress, paySats)

            let dispenseRow = await indexerDatabase.waitForDispense({
                txHash: payTx, source: buyerAddress, giveTick: tick, status: "valid"
            }, 60000)
            assert(dispenseRow, "a payment 20h after the quote must still settle inside the window")

            let credit = await indexerDatabase.waitForCredit({
                address: buyerAddress, tick: tick, amount: "5"
            }, 30000)
            assert(credit, "the 20h-old quote must price the dispense (5 tokens)")

            // Now push the ONLY quote past the window (25h back, an hour beyond the
            // 24h bound) and seed a contemporaneous validator snapshot for it, so the
            // refusal can only be the window bound and not a missing coin price.
            let pastWindowAt = chainNow - (25 * 3600)
            await priceSnapshotHelper.seedSnapshot({
                coinPair: pair, price: coinPrice.toFixed(8),
                blockTimestamp: pastWindowAt - 120, roundNumber: 999000005
            })
            await oraclePriceHelper.clearQuotes({
                sourceAddress: oracleAddress, coin: COIN_CODE, tick: tick, fiat: FIAT_WINDOW
            })
            await oraclePriceHelper.seedQuote({
                sourceAddress: oracleAddress, sourceChain: COIN_CODE,
                coin: COIN_CODE, tick: tick, fiat: FIAT_WINDOW,
                value: tokenPrice.toFixed(8), fee: '0',
                effectiveAt: pastWindowAt, actionIndex: 999000005
            })

            let stalePayTx = await transactionHelper.createSimpleTransaction(buyerAddr, dispenserAddress, paySats)
            let staleRow = await indexerDatabase.waitForDispense({
                txHash: stalePayTx, source: buyerAddress, giveTick: tick,
                status: "invalid: no matching oracle price"
            }, 60000)
            assert(staleRow, "a quote older than the 24h window must not price a dispense")
        })

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
            assert(dispenserResult.dispenser, "dispenser should be created against the in-effect quote")

            // At the OLD price:  (0.011 * 50000) / 100 = 5.5  -> 5 tokens
            // At the NEW price:  (0.011 * 50000) / 10  = 55   -> 55 tokens
            // Escrow is 100, so 55 would fit: a wrong verdict shows up as a credit,
            // not as a capacity clamp.
            let paySats = 1100000
            let payTx = await transactionHelper.createSimpleTransaction(buyerAddr, dispenserAddress, paySats)

            let dispenseRow = await indexerDatabase.waitForDispense({
                txHash: payTx, source: buyerAddress, giveTick: tick, status: "valid"
            }, 60000)
            assert(dispenseRow, "the payment should settle against the quote already in effect")

            let credit = await indexerDatabase.waitForCredit({
                address: buyerAddress, tick: tick, amount: "5"
            }, 30000)
            assert(credit, "must credit 5 (old price); 55 would mean the not-yet-effective update priced it")
        })

        it('should reject a dispense when the user oracle has published nothing in the window', async function() {
            // No quote at settlement time => reverseOraclePriceMatch returns null and
            // the dispense is recorded invalid rather than falling back to any other
            // price source.
            //
            // The quote is seeded and then REMOVED before the payment, rather than never
            // existing: since  a Mode 2 create is rejected outright unless its
            // oracle already has an effective price, so a never-priced oracle cannot get
            // as far as a dispense. Removing it afterwards models the reachable case, a
            // source-chain reorg retracting the oracle row out from under a live
            // dispenser.
            if (!(await priceSnapshotHelper.isAvailable()) || !(await oraclePriceHelper.isAvailable())) {
                console.log('Price tables not reachable; skipping Mode 2 no-quote test')
                this.skip()
                return
            }

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
                dispenserAddr,
                COIN_CODE, tick, 1, 50,
                COIN_CODE, null, 0, dispenserAddr["address"],
                FIAT_NOQ, null, oracleAddr["address"], expiration,
                null, null, 'FIAT Mode 2 no-quote dispenser'
            )
            assert(dispenserResult.dispenser, "Mode 2 dispenser should be created")

            // ...then retract it before the buyer pays.
            await oraclePriceHelper.clearQuotes({
                sourceAddress: oracleAddr["address"], coin: COIN_CODE, tick: tick, fiat: FIAT_NOQ
            })

            let txHash = await transactionHelper.createSimpleTransaction(
                buyerAddr, dispenserAddress, 1100000
            )

            let dispenseRow = await indexerDatabase.waitForDispense({
                txHash: txHash,
                source: buyerAddress,
                giveTick: tick,
                status: "invalid: no matching oracle price"
            }, 60000)
            assert(dispenseRow, "dispense should be recorded invalid with no matching oracle price")
        })
    })

    describe('v1 - cancel', () => {
        it('should create and cancel a dispenser', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("DISPENSER.V1", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "DISPv1"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, tick, 100, 100, 0, "Dispenser cancel test", 100)
            await gasHelper.ensureGasBalance(addr, '100')

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let createResult = await dispenserHelper.sendDispenserV0(
                addr,
                COIN_CODE, tick, 1, 10,
                COIN_CODE, null, 5, addr["address"],
                null, null, null, Math.floor(expirationDate.getTime() / 1000),
                null, null, 'Dispenser to cancel'
            )
            assert(createResult.dispenser, "Dispenser should be created")
            let dispenserActionIndex = Number(createResult.dispenser["action_index"])

            let cancelResult = await dispenserHelper.sendDispenserCancelV1(addr, dispenserActionIndex, "Cancelling dispenser")
            assert(cancelResult.txHash, "Cancel tx should have been sent")

            let cancellingDispenser = await indexerDatabase.waitForDispenserStatus({
                dispenserActionIndex: dispenserActionIndex,
                status: "cancelling"
            }, 30000)
            assert(cancellingDispenser, "Dispenser should be cancelling")
        })
    })

    describe('v2 - edit', () => {
        it('should create and edit a dispenser', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("DISPENSER.V2", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "DISPv2"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, tick, 200, 200, 0, "Dispenser edit test", 200)
            // EDIT v2 stretches expiration to +6 months, chargeable ~91 days at 550 gas/day = 0.5 XCHAIN.
            await gasHelper.ensureGasBalance(addr, '100')

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let createResult = await dispenserHelper.sendDispenserV0(
                addr,
                COIN_CODE, tick, 1, 10,
                COIN_CODE, null, 5, addr["address"],
                null, null, null, Math.floor(expirationDate.getTime() / 1000),
                null, null, 'Dispenser to edit'
            )
            assert(createResult.dispenser, "Dispenser should be created")
            let dispenserActionIndex = Number(createResult.dispenser["action_index"])

            let newExpiration = new Date()
            newExpiration.setMonth(newExpiration.getMonth() + 6)

            let editResult = await dispenserHelper.sendDispenserEditV2(
                addr, dispenserActionIndex,
                50, Math.floor(newExpiration.getTime() / 1000),
                null, null, "Refilling dispenser"
            )
            assert(editResult.txHash, "Edit tx should have been sent")
        })
    })
})
