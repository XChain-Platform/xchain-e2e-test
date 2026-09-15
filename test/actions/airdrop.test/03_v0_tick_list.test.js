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
const listHelper = require('../../helpers/listHelper')
const airdropHelper = require('../../helpers/airdropHelper')
const gasHelper = require('../../helpers/gasHelper')

// Covers v0 - tick list. One part of airdrop.test.js.

describe('AIRDROP', () => {

    describe('v0 - tick list', () => {
        it('should create an AIRDROP Message v0 with a tick list', async () => {
            let airdropAddressInfo = await cryptoHelper.getNewFundedAddress("AIRDROP.TICKS.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let airdropAddress = airdropAddressInfo["address"]
            let airdropTicks = [
                "AIRDROPTICv0Tick1"+airdropAddress.substring(airdropAddress.length-8),
                "AIRDROPTICv0Tick2"+airdropAddress.substring(airdropAddress.length-8),
                "AIRDROPTICv0Tick3"+airdropAddress.substring(airdropAddress.length-8)
            ]

            for (let nextTickIndex in airdropTicks){
                await issueHelper.sendIssueV0(airdropAddressInfo, airdropTicks[nextTickIndex], 100, 10, 0, "AIRDROP V0 TICK "+nextTickIndex, 10)
            }

            await gasHelper.ensureGasBalance(airdropAddressInfo, 100)

            let listAddressInfo1 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 1)
            let listAddressInfo2 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 2)
            let listAddressInfo3 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 3)
            let listAddressInfo4 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 4)
            let listAddressInfo5 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 5)
            let listAddressInfo6 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 6)
            let listAddressesInfo = [
                listAddressInfo1, listAddressInfo2, listAddressInfo3,
                listAddressInfo4, listAddressInfo5, listAddressInfo6
            ]

            // indices 0-3 get tick1; indices 4-5 get tick2
            for (let nextAddressInfoIndex in listAddressesInfo){
                if (nextAddressInfoIndex <= 3){
                    await sendHelper.sendSendV0(
                        airdropAddressInfo, airdropTicks[0], 1,
                        listAddressesInfo[nextAddressInfoIndex]["address"],
                        "AIRDROP v0 send tick to create holder list "+nextAddressInfoIndex
                    )
                } else {
                    await sendHelper.sendSendV0(
                        airdropAddressInfo, airdropTicks[1], 1,
                        listAddressesInfo[nextAddressInfoIndex]["address"],
                        "AIRDROP v0 send tick to create holder list "+nextAddressInfoIndex
                    )
                }
            }

            let listResult = await listHelper.sendListV0(airdropAddressInfo, 1, [airdropTicks[0], airdropTicks[1]])
            assert(listResult.list, "Ticker list should exist in DB")
            let airdropTicksListActionIndex = Number(listResult.list["action_index"])

            let result = await airdropHelper.sendAirdropV0(
                airdropAddressInfo, airdropTicks[2], 1, airdropTicksListActionIndex, "AIRDROP TICKS TEST V0"
            )
            assert(result.airdrop, "Airdrop v0 tick list should exist in DB")
        })
    })
})
