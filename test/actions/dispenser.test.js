// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const transactionHelper = require('../transactionHelper')
const issueHelper = require('../helpers/issueHelper')
const dispenserHelper = require('../helpers/dispenserHelper')
const priceSnapshotHelper = require('../helpers/priceSnapshotHelper')
const gasHelper = require('../helpers/gasHelper')

describe('DISPENSER', () => {
    describe('v0', () => {
        it('should create a DISPENSER Message v0', async () => {
            let dispenserAddressInfo = await cryptoHelper.getNewFundedAddress("DISPENSER.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let dispenserAddress = dispenserAddressInfo["address"]
            let dispenserTick = "DISPENSERv0"+dispenserAddress.substring(dispenserAddress.length-8)

            await issueHelper.sendIssueV0(dispenserAddressInfo, dispenserTick, 100, 100, 0, "Dispenser v0 test", 100)
            // 3-month expiration tips ~2 days past the 90-day free window — needs GAS for the fee.
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

            // Get a dispense
            let txHash = await transactionHelper.createSimpleTransaction(
                dispenseAddressInfo, dispenserAddress, 5000000
            )

            // Check if the dispense exists
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

            // Issue token with 4 decimals, escrow 50 units in dispenser
            await issueHelper.sendIssueV0(dispenserAddr, tick, 100, 100, 4, "Dispenser balance test", 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            // Dispenser: give 2.5000 tokens per 0.001 BTC (100000 sats)
            let dispenserResult = await dispenserHelper.sendDispenserV0(
                dispenserAddr,
                COIN_CODE, tick, "2.5", 50,
                COIN_CODE, null, 0.001, dispenserAddr["address"],
                null, null, null, expiration,
                null, null, 'Balance verification dispenser'
            )
            assert(dispenserResult.dispenser, "Dispenser should be created")

            // Buyer sends 0.002 BTC (200000 sats) -> should get 2 * 2.5 = 5.0000 tokens
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

            // Verify buyer received credit
            let credit = await indexerDatabase.waitForCredit({
                address: buyerAddress,
                tick: tick,
                amount: "5"
            }, 30000)
            assert(credit, "Buyer should be credited 5 tokens")

            // Verify escrow debit happened at dispenser creation (50 tokens escrowed)
            let debit = await indexerDatabase.waitForDebit({
                address: dispenserAddress,
                tick: tick,
                amount: "50"
            }, 30000)
            assert(debit, "Dispenser should have escrowed 50 tokens")
        })
    })

    describe('v0 - FIAT (Mode 1 — validator price oracle)', () => {
        it('should dispense priced from a seeded FIAT price snapshot', async function() {
            // Mode 1 derives the coin price from FIAT_AMOUNT and a finalized
            // GET_COIN/FIAT price_snapshots row (24h reverse-match, newest-first).
            // We clear the pair and seed exactly one deterministic row, so the
            // assertion is exact. This assumes the e2e regtest hub is not
            // continuously finalizing live CoinGecko rows for this pair
            // (the planned Slice-1 design — CoinGecko prices are mainnet-live
            // and cannot be asserted exactly).
            if (!(await priceSnapshotHelper.isAvailable())) {
                console.log('Hub DB (price_snapshots) not reachable — skipping FIAT dispenser test')
                this.skip()
                return
            }

            let dispenserAddr = await cryptoHelper.getNewFundedAddress("DISPENSER.FIAT", COIN, NETWORK, null, "legacy", 0, 1)
            let buyerAddr     = await cryptoHelper.getNewFundedAddress("DISPENSER.FIAT.BUYER", COIN, NETWORK, null, "legacy", 0, 1)
            let dispenserAddress = dispenserAddr["address"]
            let buyerAddress     = buyerAddr["address"]
            let tick = "DISPFIAT"+dispenserAddress.substring(dispenserAddress.length-8)

            // 0-decimal token; escrow 50 units in the dispenser.
            await issueHelper.sendIssueV0(dispenserAddr, tick, 100, 100, 0, "FIAT dispenser test", 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            // FIAT dispenser: priced at 100.00 USD per 1 token. GET_AMOUNT is
            // ignored for FIAT dispensers (pass 0).
            let dispenserResult = await dispenserHelper.sendDispenserV0(
                dispenserAddr,
                COIN_CODE, tick, 1, 50,
                COIN_CODE, null, 0, dispenserAddr["address"],
                "USD", "100.00", null, expiration,
                null, null, 'FIAT Mode 1 dispenser'
            )
            assert(dispenserResult.dispenser, "FIAT dispenser should be created")

            // Seed a deterministic price: 1 coin = 50000 USD.
            //   coin_per_token = FIAT_AMOUNT / price = 100 / 50000 = 0.002 coin
            // Anchor the seed to the CHAIN's clock (latest block_time), 60s in
            // its past: reversePriceMatch bounds on the payment tx's BLOCK_TIME
            // and the staleness cap (ORACLE_MAX_PRICE_AGE_SECONDS = 1800s)
            // measures age vs the processed block — wall-clock seeds raced both
            // rules depending on how far regtest block timestamps drift.
            let pair  = COIN_CODE + "/USD"
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

            // Cancel
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
            // EDIT v2 stretches expiration to +6 months — chargeable ~91 days at 550 gas/day = 0.5 XCHAIN.
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

            // Edit: add more escrow
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
