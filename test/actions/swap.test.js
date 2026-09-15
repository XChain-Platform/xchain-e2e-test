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
const swapHelper = require('../helpers/swapHelper')

describe('SWAP', () => {
    describe('v0 - create', () => {
        it('should create a swap v0', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("SWAP.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let giveTick = "SWPGIVEv0"+address.substring(address.length-8)
            let getTick = "SWPGETv0"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, giveTick, 100, 50, 0, "Swap give token", 50)
            await issueHelper.sendIssueV0(addr, getTick, 100, 50, 0, "Swap get token", 50)

            await gasHelper.ensureGasBalance(addr, 100)

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
})
