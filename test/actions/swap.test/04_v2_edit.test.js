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
const swapHelper = require('../../helpers/swapHelper')

// Covers v2 - edit. One part of swap.test.js.

describe('SWAP', () => {

    describe('v2 - edit', () => {
        it('should create and edit a swap', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("SWAP.V2", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let giveTick = "SWPGIVEv2"+address.substring(address.length-8)
            let getTick = "SWPGETv2"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, giveTick, 100, 50, 0, "Swap edit give token", 50)
            await issueHelper.sendIssueV0(addr, getTick, 100, 50, 0, "Swap edit get token", 50)
            await gasHelper.ensureGasBalance(addr, 100)

            let expirationDate = new Date()
            expirationDate.setMonth(expirationDate.getMonth() + 3)

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
