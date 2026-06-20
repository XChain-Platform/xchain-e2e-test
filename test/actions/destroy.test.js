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
const destroyHelper = require('../helpers/destroyHelper')

describe('DESTROY', () => {
    describe('v0', () => {
        it('should destroy tokens v0', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("DESTROY.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let tick = "DESTROYv0"+addr["address"].substring(addr["address"].length-8)

            await issueHelper.sendIssueV0(addr, tick, 100, 50, 0, "Destroy v0 test token", 50)

            let result = await destroyHelper.sendDestroyV0(addr, tick, 10, "Destroying 10 tokens")
            assert(result.destroy, "Destroy v0 should exist in DB")
            assert(result.debit, "Destroy v0 debit should exist in DB")
        })
    })

    describe('v1', () => {
        it('should destroy multiple tokens v1', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("DESTROY.V1", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick1 = "DESTv1A"+address.substring(address.length-8)
            let tick2 = "DESTv1B"+address.substring(address.length-8)

            let issue1 = await issueHelper.sendIssueV0(addr, tick1, 100, 50, 0, "Destroy v1 token A", 50)
            assert(issue1.issue, "Issue token A should exist in DB")
            let issue2 = await issueHelper.sendIssueV0(addr, tick2, 100, 50, 0, "Destroy v1 token B", 50)
            assert(issue2.issue, "Issue token B should exist in DB")

            let result = await destroyHelper.sendDestroyV1(addr, [
                { tick: tick1, amount: 5 },
                { tick: tick2, amount: 10 }
            ], "Multi-destroy v1")
            assert(result.destroy, "Destroy v1 should exist in DB")
        })
    })

    describe('v2', () => {
        it('should destroy multiple tokens with per-destroy memos v2', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("DESTROY.V2", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick1 = "DESTv2A"+address.substring(address.length-8)
            let tick2 = "DESTv2B"+address.substring(address.length-8)

            let issue1 = await issueHelper.sendIssueV0(addr, tick1, 100, 50, 0, "Destroy v2 token A", 50)
            assert(issue1.issue, "Issue token A should exist in DB")
            let issue2 = await issueHelper.sendIssueV0(addr, tick2, 100, 50, 0, "Destroy v2 token B", 50)
            assert(issue2.issue, "Issue token B should exist in DB")

            let result = await destroyHelper.sendDestroyV2(addr, [
                { tick: tick1, amount: 5, memo: "Burning token A" },
                { tick: tick2, amount: 10, memo: "Burning token B" }
            ])
            assert(result.destroy, "Destroy v2 should exist in DB")
        })
    })
})
