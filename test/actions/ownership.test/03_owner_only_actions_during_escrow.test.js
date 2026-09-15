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
// Covers Owner-only actions during ownership escrow. One part of ownership.test.js.

describe('OWNERSHIP', () => {

    // Scenario 3: Multiple owner-only actions rejected while escrowed
    // Covers ISSUE / child-ISSUE guard surface; confirms isOwnershipEscrowed()
    // is wired in each handler.
    describe('Owner-only actions during ownership escrow', () => {
        it('should reject ISSUE-edit and child-ISSUE while ownership is escrowed', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("OWN.GUARD", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let parent  = "OWNGRP"+address.substring(address.length-8)
            let settle  = "OWNGRS"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, parent, 100, 50, 0, "Parent for guard test", 50)
            await issueHelper.sendIssueV0(addr, settle, 100, 50, 0, "Settle for guard test", 50)
            await gasHelper.ensureGasBalance(addr, 100)

            let expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90

            await orderHelper.sendOrderV0(addr, COIN_CODE, parent, null, COIN_CODE, settle, 1, address, expiration, null, null, "Listing parent ownership", 1, 0)

            // ISSUE v5 (ALLOW_LIST / BLOCK_LIST edit) is also owner-only and should be rejected.
            // Raw send for the same reason as the v1 edit above: the helper that waits
            // for status=valid throws on a refusal this test exists to observe.
            await issueHelper.sendIssueV5Raw(addr, parent, "", "", "Trying to lock-list while escrowed")
            let rejectedV5 = await indexerDatabase.waitForIssue({ source: address, tick: parent, status: "invalid: TICK (ownership escrowed)" }, 30000)
            assert(rejectedV5, "ISSUE v5 should be rejected while parent ownership is escrowed")

            // Child ISSUE (parent.child) is also gated; uses the 'parent ownership escrowed' message.
            // Raw send: this ISSUE is SUPPOSED to be refused, and sendIssueV0 waits for
            // status=valid and throws when it never arrives.
            let child = parent + ".SUB1"
            await issueHelper.sendIssueV0Raw(addr, child, 10, 5, 0, "Trying to mint child while parent escrowed", 5)
            let rejectedChild = await indexerDatabase.waitForIssue({ source: address, tick: child, status: "invalid: TICK (parent ownership escrowed)" }, 30000)
            assert(rejectedChild, "Child ISSUE should be rejected while parent ownership is escrowed")
        })
    })
})
