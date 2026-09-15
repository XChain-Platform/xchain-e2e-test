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

            await issueHelper.sendIssueV0(addr, holderTick, 100, 10, 0, "Dividend holder token", 10)

            let holder1 = await cryptoHelper.getNewAddress("DIVIDEND.V0", COIN, NETWORK, null, "legacy", 1)
            let holder2 = await cryptoHelper.getNewAddress("DIVIDEND.V0", COIN, NETWORK, null, "legacy", 2)

            await sendHelper.sendSendV0(addr, holderTick, 2, holder1["address"], "Dividend holder 1")
            await sendHelper.sendSendV0(addr, holderTick, 3, holder2["address"], "Dividend holder 2")

            await issueHelper.sendIssueV0(addr, dividendTick, 1000, 100, 0, "Dividend payout token", 100)

            await gasHelper.ensureGasBalance(addr, 100)

            let result = await dividendHelper.sendDividendV0(
                addr, holderTick, dividendTick, 1, "Dividend test v0"
            )
            assert(result.dividend, "Dividend v0 should exist in DB")
        })
    })
})
