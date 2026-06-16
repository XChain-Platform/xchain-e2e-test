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
const dividendHelper = require('../helpers/dividendHelper')

describe('DIVIDEND', () => {
    describe('v0', () => {
        it('should pay a dividend v0', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("DIVIDEND.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let holderTick = "DIVHOLDv0"+address.substring(address.length-8)
            let dividendTick = "DIVPAYv0"+address.substring(address.length-8)

            // Create the holder tick and send to some addresses to create holders
            await issueHelper.sendIssueV0(addr, holderTick, 100, 10, 0, "Dividend holder token", 10)

            let holder1 = await cryptoHelper.getNewAddress("DIVIDEND.V0", COIN, NETWORK, null, "legacy", 1)
            let holder2 = await cryptoHelper.getNewAddress("DIVIDEND.V0", COIN, NETWORK, null, "legacy", 2)

            await sendHelper.sendSendV0(addr, holderTick, 2, holder1["address"], "Dividend holder 1")
            await sendHelper.sendSendV0(addr, holderTick, 3, holder2["address"], "Dividend holder 2")

            // Create the dividend tick (what to distribute)
            await issueHelper.sendIssueV0(addr, dividendTick, 1000, 100, 0, "Dividend payout token", 100)

            // Mint gas for fee
            await gasHelper.mintGas(addr, 100)

            // Pay dividend
            let result = await dividendHelper.sendDividendV0(
                addr, holderTick, dividendTick, 1, "Dividend test v0"
            )
            assert(result.dividend, "Dividend v0 should exist in DB")
        })
    })

    describe('v0 - balance verification', () => {
        it('should credit holders proportionally and debit source', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("DIVIDEND.BAL", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let holderTick = "DVBALHv0"+address.substring(address.length-8)
            let dividendTick = "DVBALPv0"+address.substring(address.length-8)

            // Issue holder token: 10 supply, send to 2 holders
            // addr keeps 5, holder1 gets 2, holder2 gets 3
            await issueHelper.sendIssueV0(addr, holderTick, 100, 10, 0, "Dividend balance holder", 10)

            let holder1 = await cryptoHelper.getNewAddress("DIVIDEND.BAL", COIN, NETWORK, null, "legacy", 1)
            let holder2 = await cryptoHelper.getNewAddress("DIVIDEND.BAL", COIN, NETWORK, null, "legacy", 2)

            await sendHelper.sendSendV0(addr, holderTick, 2, holder1["address"], "Holder 1")
            await sendHelper.sendSendV0(addr, holderTick, 3, holder2["address"], "Holder 2")

            // Issue dividend token and pay 10 per unit held
            // holder1 has 2 units -> should get 20
            // holder2 has 3 units -> should get 30
            // addr has 5 units -> should get 50
            await issueHelper.sendIssueV0(addr, dividendTick, 1000, 100, 0, "Dividend balance payout", 100)

            await gasHelper.mintGas(addr, 100)

            let result = await dividendHelper.sendDividendV0(
                addr, holderTick, dividendTick, 10, "Dividend balance test"
            )
            assert(result.dividend, "Dividend should exist in DB")

            // Verify credits to holders
            let credit1 = await indexerDatabase.waitForCredit({
                address: holder1["address"],
                tick: dividendTick,
                amount: "20"
            }, 30000)
            assert(credit1, "Holder1 (2 units) should receive 20 dividend tokens")

            let credit2 = await indexerDatabase.waitForCredit({
                address: holder2["address"],
                tick: dividendTick,
                amount: "30"
            }, 30000)
            assert(credit2, "Holder2 (3 units) should receive 30 dividend tokens")

            // Verify source was debited (only external holders: 2*10 + 3*10 = 50)
            let debit = await indexerDatabase.waitForDebit({
                address: address,
                tick: dividendTick,
                amount: "50"
            }, 30000)
            assert(debit, "Source should be debited 50 tokens (external holders only)")
        })
    })
})
