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
const issueHelper = require('../helpers/issueHelper')
const sendHelper = require('../helpers/sendHelper')
const gasHelper = require('../helpers/gasHelper')
const swapHelper = require('../helpers/swapHelper')

describe('SWAP', () => {
    describe('v0 - create', () => {
        it('should create a swap v0', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("SWAP.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let giveTick = "SWPGIVEv0"+address.substring(address.length-8)
            let getTick = "SWPGETv0"+address.substring(address.length-8)

            // Create give and get tokens
            await issueHelper.sendIssueV0(addr, giveTick, 100, 50, 0, "Swap give token", 50)
            await issueHelper.sendIssueV0(addr, getTick, 100, 50, 0, "Swap get token", 50)

            // Mint gas for fee
            await gasHelper.mintGas(addr, 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            let result = await swapHelper.sendSwapV0(
                addr,
                COIN_CODE, giveTick, 10,
                COIN_CODE, getTick, 5,
                address,
                Math.floor(expirationDate.getTime() / 1000),
                null, null,
                "Swap test v0"
            )
            assert(result.swap, "Swap v0 should exist in DB")
        })
    })

    describe('v1 - cancel', () => {
        it('should create and cancel a swap', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("SWAP.V1", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let giveTick = "SWPGIVEv1"+address.substring(address.length-8)
            let getTick = "SWPGETv1"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, giveTick, 100, 50, 0, "Swap cancel give token", 50)
            await issueHelper.sendIssueV0(addr, getTick, 100, 50, 0, "Swap cancel get token", 50)
            await gasHelper.mintGas(addr, 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            // Create swap
            let createResult = await swapHelper.sendSwapV0(
                addr,
                COIN_CODE, giveTick, 10,
                COIN_CODE, getTick, 5,
                address,
                Math.floor(expirationDate.getTime() / 1000),
                null, null,
                "Swap to cancel"
            )
            assert(createResult.swap, "Swap should be created")
            let swapActionIndex = Number(createResult.swap["action_index"])

            // Cancel the swap
            let cancelResult = await swapHelper.sendSwapCancelV1(addr, swapActionIndex, "Cancelling swap")
            assert(cancelResult.txHash, "Swap cancel tx should have been sent")

            // Verify original swap is no longer 'open'
            let closedSwap = await indexerDatabase.waitForSwap({
                source: address,
                giveTick: giveTick,
                swapStatus: "cancelled"
            }, 30000)
            assert(closedSwap, "Swap should be closed after cancel")
        })
    })

    describe('match - full exchange', () => {
        it('should match two counter-swaps and complete the exchange', async () => {
            // Two separate addresses — matching requires different SOURCE
            let addr1 = await cryptoHelper.getNewFundedAddress("SWAP.MATCH1", COIN, NETWORK, null, "legacy", 0, 1)
            let addr2 = await cryptoHelper.getNewFundedAddress("SWAP.MATCH2", COIN, NETWORK, null, "legacy", 0, 1)
            let address1 = addr1["address"]
            let address2 = addr2["address"]
            let tokenA = "SWPMA"+address1.substring(address1.length-8)
            let tokenB = "SWPMB"+address1.substring(address1.length-8)

            // addr1 creates both tokens
            await issueHelper.sendIssueV0(addr1, tokenA, 100, 50, 0, "Swap match token A", 50)
            await issueHelper.sendIssueV0(addr1, tokenB, 100, 50, 0, "Swap match token B", 50)

            // addr1 sends tokenB to addr2 so addr2 can offer it
            await sendHelper.sendSendV0(addr1, tokenB, 20, address2, "Fund addr2 with tokenB")

            // Both need gas for swap fees
            await gasHelper.mintGas(addr1, 100)
            await gasHelper.mintGas(addr2, 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90 // 90 days

            // addr1: GIVE 10 tokenA, GET 5 tokenB
            let swap1 = await swapHelper.sendSwapV0(
                addr1,
                COIN_CODE, tokenA, 10,
                COIN_CODE, tokenB, 5,
                address1, expiration,
                null, null, "Selling tokenA for tokenB"
            )
            assert(swap1.swap, "Swap 1 should exist in DB")
            let swap1ActionIndex = Number(swap1.swap["action_index"])

            // addr2: GIVE 5 tokenB, GET 10 tokenA (exact counter-swap)
            let swap2 = await swapHelper.sendSwapV0(
                addr2,
                COIN_CODE, tokenB, 5,
                COIN_CODE, tokenA, 10,
                address2, expiration,
                null, null, "Buying tokenA with tokenB"
            )
            assert(swap2.swap, "Swap 2 should exist in DB")
            let swap2ActionIndex = Number(swap2.swap["action_index"])

            // Verify the match was created
            let match = await indexerDatabase.waitForSwapMatch({
                giveActionIndex: swap1ActionIndex,
                getActionIndex: swap2ActionIndex,
                status: "valid"
            }, 30000)
            assert(match, "Swap match should exist in DB")

            // Verify both swaps are now complete
            let completedSwap1 = await indexerDatabase.waitForSwap({
                source: address1,
                giveTick: tokenA,
                swapStatus: "complete"
            }, 30000)
            assert(completedSwap1, "Swap 1 should be complete")

            let completedSwap2 = await indexerDatabase.waitForSwap({
                source: address2,
                giveTick: tokenB,
                swapStatus: "complete"
            }, 30000)
            assert(completedSwap2, "Swap 2 should be complete")
        })
    })

    describe('v2 - edit', () => {
        it('should create and edit a swap', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("SWAP.V2", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let giveTick = "SWPGIVEv2"+address.substring(address.length-8)
            let getTick = "SWPGETv2"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, giveTick, 100, 50, 0, "Swap edit give token", 50)
            await issueHelper.sendIssueV0(addr, getTick, 100, 50, 0, "Swap edit get token", 50)
            await gasHelper.mintGas(addr, 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

            // Create swap
            let createResult = await swapHelper.sendSwapV0(
                addr,
                COIN_CODE, giveTick, 10,
                COIN_CODE, getTick, 5,
                address,
                Math.floor(expirationDate.getTime() / 1000),
                null, null,
                "Swap to edit"
            )
            assert(createResult.swap, "Swap should be created")
            let swapActionIndex = Number(createResult.swap["action_index"])

            // Edit: extend expiration
            let newExpiration = new Date()
            newExpiration.setMonth(newExpiration.getMonth() + 6)

            let editResult = await swapHelper.sendSwapEditV2(
                addr, swapActionIndex,
                Math.floor(newExpiration.getTime() / 1000),
                null, null, "Extending swap expiration"
            )
            assert(editResult.txHash, "Swap edit tx should have been sent")
        })
    })
})
