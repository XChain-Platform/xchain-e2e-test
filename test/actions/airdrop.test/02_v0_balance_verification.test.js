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

// Covers v0 - balance verification. One part of airdrop.test.js.

describe('AIRDROP', () => {

    describe('v0 - balance verification', () => {
        it('should credit each recipient and debit the source', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("AIRDROP.BAL.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "AIRBALv0"+address.substring(address.length-8)

            await gasHelper.ensureGasBalance(addr, 100)
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
})
