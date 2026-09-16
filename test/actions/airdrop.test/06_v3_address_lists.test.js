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

// Covers v3. One part of airdrop.test.js.

describe('AIRDROP', () => {

    describe('v3', () => {
        it('should create an AIRDROP Message v3 with an address list', async () => {
            let airdropAddressInfo = await cryptoHelper.getNewFundedAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy", 0, 1)
            let airdropAddress = airdropAddressInfo["address"]
            let airdropTick1 = "AIRDROP1ADDv3"+airdropAddress.substring(airdropAddress.length-8)
            let airdropTick2 = "AIRDROP2ADDv3"+airdropAddress.substring(airdropAddress.length-8)

            await gasHelper.ensureGasBalance(airdropAddressInfo, 100)

            await issueHelper.sendIssueV0(airdropAddressInfo, airdropTick1, 100, 100, 0, "Airdrop1 address v3 test", 100)
            await issueHelper.sendIssueV0(airdropAddressInfo, airdropTick2, 100, 100, 0, "Airdrop2 address v3 test", 100)

            let listAddressInfo1 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy", 1)
            let listAddressInfo2 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy", 2)
            let listAddressInfo3 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy", 3)
            let listAddressInfo4 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy", 4)
            let listAddressInfo5 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy", 5)
            let listAddressInfo6 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy", 6)

            let listResult1 = await listHelper.sendListV0(airdropAddressInfo, 2, [
                listAddressInfo1["address"], listAddressInfo2["address"],
                listAddressInfo3["address"], listAddressInfo4["address"]
            ])
            assert(listResult1.list, "First address list should exist in DB")
            let airdropAddressListActionIndex1 = Number(listResult1.list["action_index"])

            let listResult2 = await listHelper.sendListV0(airdropAddressInfo, 2, [
                listAddressInfo5["address"], listAddressInfo6["address"],
            ])
            assert(listResult2.list, "Second address list should exist in DB")
            let airdropAddressListActionIndex2 = Number(listResult2.list["action_index"])

            let result = await airdropHelper.sendAirdropV3(
                airdropAddressInfo, airdropTick1, 1, airdropTick2, 2,
                airdropAddressListActionIndex1, airdropAddressListActionIndex2,
                "AIRDROP ADDRESSES TEST V3 memo1", "AIRDROP ADDRESSES TEST V3 memo2"
            )
            assert(result.airdrop1, "Airdrop v3 first tick should exist in DB")
            assert(result.airdrop2, "Airdrop v3 second tick should exist in DB")
        })
    })
})
