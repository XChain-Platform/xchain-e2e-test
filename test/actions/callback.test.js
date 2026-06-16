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
const issueHelper = require('../helpers/issueHelper')
const sendHelper = require('../helpers/sendHelper')
const gasHelper = require('../helpers/gasHelper')
const callbackHelper = require('../helpers/callbackHelper')

describe('CALLBACK', () => {
    describe('v0', () => {
        it('should perform a callback v0', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("CALLBACK.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let callbackTick = "CBTICKv0"+address.substring(address.length-8)
            let mainTick = "CBMAINv0"+address.substring(address.length-8)

            // Create the callback tick (what holders will receive)
            let callbackIssueResult = await issueHelper.sendIssueV0(
                addr, callbackTick, 1000, 100, 0, "Callback payout token", 100
            )

            // Create the main tick WITH callback params
            // callbackBlock=1 (already passed), callbackTick, callbackAmount=1
            let mainIssueResult = await issueHelper.sendIssueV0(
                addr, mainTick, 100, 10, 0, "Callback main token", 10,
                '', '', '', '', '', '', '', // transfer through lockCallback
                1, // callbackBlock = 1 (very low, already passed)
                callbackTick, // callbackTick
                1  // callbackAmount per unit
            )

            // Send mainTick to create holders
            let holder1 = await cryptoHelper.getNewAddress("CALLBACK.V0", COIN, NETWORK, null, "legacy", 1)
            let holder2 = await cryptoHelper.getNewAddress("CALLBACK.V0", COIN, NETWORK, null, "legacy", 2)
            await sendHelper.sendSendV0(addr, mainTick, 2, holder1["address"], "Callback holder 1")
            await sendHelper.sendSendV0(addr, mainTick, 3, holder2["address"], "Callback holder 2")

            // Mint gas for fee
            await gasHelper.mintGas(addr, 100)

            // Perform callback
            let result = await callbackHelper.sendCallbackV0(addr, mainTick, "Callback test v0")
            assert(result.callback, "Callback v0 should exist in DB")
        })
    })
})
