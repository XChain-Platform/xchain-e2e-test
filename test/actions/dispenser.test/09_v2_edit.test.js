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
const dispenserHelper = require('../../helpers/dispenserHelper')
const gasHelper = require('../../helpers/gasHelper')



describe('DISPENSER', () => {

    describe('v2 - edit', () => {
        it('should create and edit a dispenser', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("DISPENSER.V2", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "DISPv2"+address.substring(address.length-8)

            await issueHelper.sendIssueV0(addr, tick, 200, 200, 0, "Dispenser edit test", 200)
            // EDIT v2 stretches expiration to +6 months, chargeable ~91 days at 550 gas/day = 0.5 XCHAIN.
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