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
            let airdropAddressInfo = await cryptoHelper.getNewFundedAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let airdropAddress = airdropAddressInfo["address"]
            let airdropTick = "AIRDROPADDv0"+airdropAddress.substring(airdropAddress.length-8)

            await gasHelper.mintGas(airdropAddressInfo, 100)

            await issueHelper.sendIssueV0(airdropAddressInfo, airdropTick, 100, 100, 0, "Airdrop address v0 test", 100)

            let listAddressInfo1 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 1)
            let listAddressInfo2 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 2)
            let listAddressInfo3 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 3)
            let listAddressInfo4 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 4)
            let listAddressInfo5 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 5)
            let listAddressInfo6 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V0", COIN, NETWORK, null, "legacy", 6)

            let listResult = await listHelper.sendListV0(airdropAddressInfo, 2, [
                listAddressInfo1["address"], listAddressInfo2["address"], listAddressInfo3["address"],
                listAddressInfo4["address"], listAddressInfo5["address"], listAddressInfo6["address"],
            ])
            assert(listResult.list, "Address list should exist in DB")
            let airdropAddressListActionIndex = Number(listResult.list["action_index"])

            let result = await airdropHelper.sendAirdropV0(
                airdropAddressInfo, airdropTick, 1, airdropAddressListActionIndex, "AIRDROP ADDRESSES TEST V0"
            )
            assert(result.airdrop, "Airdrop v0 should exist in DB")
        })
    })

    describe('v0 - balance verification', () => {
        it('should credit each recipient and debit the source', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("AIRDROP.BAL.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "AIRBALv0"+address.substring(address.length-8)

            await gasHelper.mintGas(addr, 100)
            await issueHelper.sendIssueV0(addr, tick, 1000, 100, 0, "Airdrop balance test", 100)

            let r1 = await cryptoHelper.getNewAddress("AIRDROP.BAL.V0", COIN, NETWORK, null, "legacy", 1)
            let r2 = await cryptoHelper.getNewAddress("AIRDROP.BAL.V0", COIN, NETWORK, null, "legacy", 2)
            let r3 = await cryptoHelper.getNewAddress("AIRDROP.BAL.V0", COIN, NETWORK, null, "legacy", 3)

            let listResult = await listHelper.sendListV0(addr, 2, [
                r1["address"], r2["address"], r3["address"]
            ])
            assert(listResult.list, "Address list should exist")
            let listAI = Number(listResult.list["action_index"])

            let result = await airdropHelper.sendAirdropV0(addr, tick, 5, listAI, "Balance check airdrop")
            assert(result.airdrop, "Airdrop should exist in DB")

            let credit1 = await indexerDatabase.waitForCredit({ address: r1["address"], tick: tick, amount: "5" }, 30000)
            assert(credit1, "Recipient 1 should be credited 5 tokens")

            let credit2 = await indexerDatabase.waitForCredit({ address: r2["address"], tick: tick, amount: "5" }, 30000)
            assert(credit2, "Recipient 2 should be credited 5 tokens")

            let credit3 = await indexerDatabase.waitForCredit({ address: r3["address"], tick: tick, amount: "5" }, 30000)
            assert(credit3, "Recipient 3 should be credited 5 tokens")

            let debit = await indexerDatabase.waitForDebit({ address: address, tick: tick, amount: "15" }, 30000)
            assert(debit, "Source should be debited 15 tokens")
        })
    })

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
                await issueHelper.sendIssueV0(
                    airdropAddressInfo, airdropTicks[nextTickIndex],
                    100, 10, 0, "AIRDROP V0 TICK "+nextTickIndex, 10
                )
            }

            await gasHelper.mintGas(airdropAddressInfo, 100)

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

    describe('v1', () => {
        it('should create an AIRDROP Message v1 with an address list', async () => {
            let airdropAddressInfo = await cryptoHelper.getNewFundedAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy", 0, 1)
            let airdropAddress = airdropAddressInfo["address"]
            let airdropTick1 = "AIRDROP1ADDv1"+airdropAddress.substring(airdropAddress.length-8)
            let airdropTick2 = "AIRDROP2ADDv1"+airdropAddress.substring(airdropAddress.length-8)

            await gasHelper.mintGas(airdropAddressInfo, 100)

            await issueHelper.sendIssueV0(airdropAddressInfo, airdropTick1, 100, 100, 0, "Airdrop1 address v1 test", 100)
            await issueHelper.sendIssueV0(airdropAddressInfo, airdropTick2, 100, 100, 0, "Airdrop2 address v1 test", 100)

            let listAddressInfo1 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy", 1)
            let listAddressInfo2 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy", 2)
            let listAddressInfo3 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy", 3)
            let listAddressInfo4 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy", 4)
            let listAddressInfo5 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy", 5)
            let listAddressInfo6 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V1", COIN, NETWORK, null, "legacy", 6)

            let listResult = await listHelper.sendListV0(airdropAddressInfo, 2, [
                listAddressInfo1["address"], listAddressInfo2["address"], listAddressInfo3["address"],
                listAddressInfo4["address"], listAddressInfo5["address"], listAddressInfo6["address"],
            ])
            assert(listResult.list, "Address list should exist in DB")
            let airdropAddressListActionIndex = Number(listResult.list["action_index"])

            let result = await airdropHelper.sendAirdropV1(
                airdropAddressInfo, airdropTick1, 1, airdropTick2, 2,
                airdropAddressListActionIndex, "AIRDROP ADDRESSES TEST V1"
            )
            assert(result.airdrop1, "Airdrop v1 first tick should exist in DB")
            assert(result.airdrop2, "Airdrop v1 second tick should exist in DB")
        })
    })

    describe('v2', () => {
        it('should create an AIRDROP Message v2 with an address list', async () => {
            let airdropAddressInfo = await cryptoHelper.getNewFundedAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy", 0, 1)
            let airdropAddress = airdropAddressInfo["address"]
            let airdropTick1 = "AIRDROP1ADDv2"+airdropAddress.substring(airdropAddress.length-8)
            let airdropTick2 = "AIRDROP2ADDv2"+airdropAddress.substring(airdropAddress.length-8)

            await gasHelper.mintGas(airdropAddressInfo, 100)

            await issueHelper.sendIssueV0(airdropAddressInfo, airdropTick1, 100, 100, 0, "Airdrop1 address v2 test", 100)
            await issueHelper.sendIssueV0(airdropAddressInfo, airdropTick2, 100, 100, 0, "Airdrop2 address v2 test", 100)

            let listAddressInfo1 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy", 1)
            let listAddressInfo2 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy", 2)
            let listAddressInfo3 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy", 3)
            let listAddressInfo4 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy", 4)
            let listAddressInfo5 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy", 5)
            let listAddressInfo6 = await cryptoHelper.getNewAddress("AIRDROP.ADDRESSES.V2", COIN, NETWORK, null, "legacy", 6)

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

            let result = await airdropHelper.sendAirdropV2(
                airdropAddressInfo, airdropTick1, 1, airdropTick2, 2,
                airdropAddressListActionIndex1, airdropAddressListActionIndex2,
                "AIRDROP ADDRESSES TEST V2"
            )
            assert(result.airdrop1, "Airdrop v2 first tick should exist in DB")
            assert(result.airdrop2, "Airdrop v2 second tick should exist in DB")
        })
    })

    describe('v3', () => {
        it('should create an AIRDROP Message v3 with an address list', async () => {
            let airdropAddressInfo = await cryptoHelper.getNewFundedAddress("AIRDROP.ADDRESSES.V3", COIN, NETWORK, null, "legacy", 0, 1)
            let airdropAddress = airdropAddressInfo["address"]
            let airdropTick1 = "AIRDROP1ADDv3"+airdropAddress.substring(airdropAddress.length-8)
            let airdropTick2 = "AIRDROP2ADDv3"+airdropAddress.substring(airdropAddress.length-8)

            await gasHelper.mintGas(airdropAddressInfo, 100)

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
