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
const listHelper = require('../helpers/listHelper')
const airdropHelper = require('../helpers/airdropHelper')
const gasHelper = require('../helpers/gasHelper')

describe('AIRDROP', () => {
    describe('v0 - address list', () => {
        it('should create an AIRDROP Message v0 with an address list', async () => {
            const airdropAddressInfo = await cryptoHelper.getNewFundedAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 0, 1)
            const airdropAddress = airdropAddressInfo["address"]
            const airdropTick = "AIRDROPADDv0"+airdropAddress.substring(airdropAddress.length-8)

            await gasHelper.ensureGasBalance(airdropAddressInfo, 100)

            await issueHelper.sendIssueV0(airdropAddressInfo, airdropTick, 100, 100, 0, "Airdrop address v0 test", 100)

            const listAddressInfo1 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 1)
            const listAddressInfo2 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 2)
            const listAddressInfo3 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 3)
            const listAddressInfo4 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 4)
            const listAddressInfo5 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 5)
            const listAddressInfo6 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 6)

            const listResult = await listHelper.sendListV0(airdropAddressInfo, 2, [
                listAddressInfo1["address"], listAddressInfo2["address"], listAddressInfo3["address"],
                listAddressInfo4["address"], listAddressInfo5["address"], listAddressInfo6["address"],
            ])
            assert(listResult.list, "Address list should exist in DB")
            const airdropAddressListActionIndex = Number(listResult.list["action_index"])

            const result = await airdropHelper.sendAirdropV0(
                airdropAddressInfo, airdropTick, 1, airdropAddressListActionIndex, "AIRDROP ADDRESSES TEST V0"
            )
            assert(result.airdrop, "Airdrop v0 should exist in DB")
        })
    })
})
