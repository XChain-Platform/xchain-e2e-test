// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const issueHelper = require('../helpers/issueHelper')
const listHelper = require('../helpers/listHelper')

describe('LIST', () => {
    describe('v0 - tickers', () => {
        it('should create a LIST Message v0 with tickers', async () => {
            let listAddress = await cryptoHelper.getNewFundedAddress("LIST.V0.TICKERS", COIN, NETWORK, null, "legacy", 0, 1)
            let addr = listAddress["address"]

            // Create two tickers to put in the list
            let tick1 = "LISTV0T1"+addr.substring(addr.length-8)
            let tick2 = "LISTV0T2"+addr.substring(addr.length-8)
            await issueHelper.sendIssueV0(listAddress, tick1, 100, 2, 0, "List v0 tick 1", 10)
            await issueHelper.sendIssueV0(listAddress, tick2, 100, 5, 0, "List v0 tick 2", 20)

            let result = await listHelper.sendListV0(listAddress, 1, [tick1, tick2])
            assert(result.list, "List v0 tickers should exist in DB")
        })
    })

    describe('v0 - addresses', () => {
        it('should create a LIST Message v0 with addresses', async () => {
            let listAddress0 = await cryptoHelper.getNewFundedAddress("LIST.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let listAddress1 = await cryptoHelper.getNewAddress("LIST.V0", COIN, NETWORK, null, "legacy", 1)
            let listAddress2 = await cryptoHelper.getNewAddress("LIST.V0", COIN, NETWORK, null, "legacy", 2)
            let listAddress3 = await cryptoHelper.getNewAddress("LIST.V0", COIN, NETWORK, null, "legacy", 3)

            let result = await listHelper.sendListV0(listAddress0, 2, [
                listAddress1["address"],
                listAddress2["address"],
                listAddress3["address"],
            ])
            assert(result.list, "List v0 addresses should exist in DB")
        })
    })

    describe('v1 - edit', () => {
        it('should create a LIST Message v1 with addresses (add + remove)', async () => {
            let listAddress0 = await cryptoHelper.getNewFundedAddress("LIST.V1", COIN, NETWORK, null, "legacy", 0, 1)
            let listAddress1 = await cryptoHelper.getNewAddress("LIST.V1", COIN, NETWORK, null, "legacy", 1)
            let listAddress2 = await cryptoHelper.getNewAddress("LIST.V1", COIN, NETWORK, null, "legacy", 2)
            let listAddress3 = await cryptoHelper.getNewAddress("LIST.V1", COIN, NETWORK, null, "legacy", 3)
            let listAddress4 = await cryptoHelper.getNewAddress("LIST.V1", COIN, NETWORK, null, "legacy", 4)
            let listAddress5 = await cryptoHelper.getNewAddress("LIST.V1", COIN, NETWORK, null, "legacy", 5)
            let listAddress6 = await cryptoHelper.getNewAddress("LIST.V1", COIN, NETWORK, null, "legacy", 6)

            // Create initial list v0
            let v0Result = await listHelper.sendListV0(listAddress0, 2, [
                listAddress1["address"],
                listAddress2["address"],
                listAddress3["address"],
            ])
            assert(v0Result.list, "Initial list v0 should exist in DB")
            let addressListV0ActionIndex = Number(v0Result.list["action_index"])

            // Edit: ADD addresses
            let v1AddResult = await listHelper.sendListV1(
                listAddress0, 1, addressListV0ActionIndex,
                [listAddress4["address"], listAddress5["address"], listAddress6["address"]],
                2,
                [
                    listAddress1["address"], listAddress2["address"], listAddress3["address"],
                    listAddress4["address"], listAddress5["address"], listAddress6["address"],
                ]
            )
            assert(v1AddResult.list, "List v1 ADD should exist in DB")
            let addressListV1ActionIndex = Number(v1AddResult.list["action_index"])

            // Edit: REMOVE an address
            let v1RemoveResult = await listHelper.sendListV1(
                listAddress0, 2, addressListV1ActionIndex,
                [listAddress4["address"]],
                2,
                [
                    listAddress1["address"], listAddress2["address"], listAddress3["address"],
                    listAddress5["address"], listAddress6["address"],
                ]
            )
            assert(v1RemoveResult.list, "List v1 REMOVE should exist in DB")
        })
    })
})
