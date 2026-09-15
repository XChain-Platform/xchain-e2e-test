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
const sendHelper = require('../../helpers/sendHelper')
const gasHelper = require('../../helpers/gasHelper')
const orderHelper = require('../../helpers/orderHelper')
const sweepHelper = require('../../helpers/sweepHelper')

// End-to-end coverage for token-ownership sales (ORDER/SWAP/DISPENSER with
// GIVE_OWNERSHIP or GET_OWNERSHIP set). Token-pair scenarios only. The
// COINPay path (ownership-for-native-coin) is exercised by the COINPay
// suite once those helpers are ownership-aware.
// Covers ORDER - ownership cancel returns the gate. One part of ownership.test.js.

describe('OWNERSHIP', () => {

    // Scenario 2: Ownership ORDER cancel returns ownership
    // Seller lists ownership then cancels; the escrow gate is released and
    // owner_id stays with the seller (it never moved).
    describe('ORDER - ownership cancel returns the gate', () => {
        it('should release the ownership escrow when an ownership order is cancelled', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("OWN.OC", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let jdog    = "OWNCANJ"+address.substring(address.length-8)
            let settle  = "OWNCANS"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, jdog,   100, 50, 0, "Ownership cancel subject", 50)
            await issueHelper.sendIssueV0(addr, settle, 100, 50, 0, "Cancel settlement tick",   50)
            await gasHelper.ensureGasBalance(addr, 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            let listed = await orderHelper.sendOrderV0(addr, COIN_CODE, jdog,   null, COIN_CODE, settle, 5, address, expiration, null, null, "Listing then cancelling", 1, 0)
            assert(listed.order, "Ownership order should be created")
            let listedAI = Number(listed.order["action_index"])

            // After listing, an ISSUE v1 description edit should be rejected
            // because the ownership gate is set.
            // Raw send: this edit is SUPPOSED to be refused, and sendIssueV1 demands
            // status=valid and now throws when it never arrives (requireRow), which
            // killed this test inside the helper before it reached its own assertion.
            await issueHelper.sendIssueV1Raw(addr, jdog, "Trying to edit while escrowed")
            // Verify the issue landed with the ownership-escrowed rejection reason.
            let rejectedIssue = await indexerDatabase.waitForIssue({ source: address, tick: jdog, status: "invalid: TICK (ownership escrowed)" }, 30000)
            assert(rejectedIssue, "ISSUE v1 should be rejected while ownership is escrowed")

            // Cancel the ownership order
            await orderHelper.sendOrderCancelV1(addr, listedAI, "Cancelling ownership listing")
            let cancelled = await indexerDatabase.waitForOrder({ source: address, giveTick: jdog, orderStatus: "cancelled" }, 30000)
            assert(cancelled, "Ownership order should be cancelled")

            // After cancel, the escrow gate is clear; owner-only actions work again
            let postCancelEdit = await issueHelper.sendIssueV1(addr, jdog, "Description after cancel")
            assert(postCancelEdit.issue, "ISSUE v1 should succeed once the ownership gate is released")
        })
    })
})
