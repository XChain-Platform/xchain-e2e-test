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
})
describe('DISPENSER', () => {
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
})

describe('DISPENSER', () => {
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
                // give-up-ok: diagnostics for the assert below; empty is a finding, not a failure.
                let debugResult = await indexerDatabase.waitForDispense({ txHash: txHash }, 5000)
                console.log("Debug - dispense by txHash only:", debugResult)
                // give-up-ok: same, widened to the source address.
                let debugResult2 = await indexerDatabase.waitForDispense({ source: dispenseAddressInfo["address"] }, 5000)
                console.log("Debug - dispense by source only:", debugResult2)
            }
            assert(dispenseRow, "Dispense should exist in DB")
        })
    })
})

describe('DISPENSER', () => {
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
})
