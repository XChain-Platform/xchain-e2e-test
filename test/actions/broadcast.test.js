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
const broadcastHelper = require('../helpers/broadcastHelper')

describe('BROADCAST', () => {
    describe('v0', () => {
        it('should create a BROADCAST Message v0', async () => {
            let broadcastAddress = await cryptoHelper.getNewFundedAddress("BROADCAST.V0", COIN, NETWORK, null, "legacy", 0, 1)

            let result = await broadcastHelper.sendBroadcastV0(broadcastAddress, "A simple BROADCAST test v0", 1)
            assert(result.broadcast, "Broadcast v0 should exist in DB")
        })
    })

    describe('v1', () => {
        it('should create a BROADCAST Message v1', async () => {
            let broadcastAddress = await cryptoHelper.getNewFundedAddress("BROADCAST.V1", COIN, NETWORK, null, "legacy", 0, 1)

            let result = await broadcastHelper.sendBroadcastV1(
                broadcastAddress, "A simple BROADCAST test v1", 1, 0.01, "Memo test for BROADCAST v1"
            )
            assert(result.broadcast, "Broadcast v1 should exist in DB")
        })
    })

    describe('v2', () => {
        it('should create a BROADCAST Message v2', async () => {
            let broadcastAddress = await cryptoHelper.getNewFundedAddress("BROADCAST.V2", COIN, NETWORK, null, "legacy", 0, 1)

            let result = await broadcastHelper.sendBroadcastV2(
                broadcastAddress, "A simple BROADCAST test v2", 0.01, "Memo test for BROADCAST v2"
            )
            assert(result.broadcast, "Broadcast v2 should exist in DB")
        })
    })

    describe('v3', () => {
        it('should create a BROADCAST Message v3', async () => {
            let broadcastAddress = await cryptoHelper.getNewFundedAddress("BROADCAST.V3", COIN, NETWORK, null, "legacy", 0, 1)

            // Create a V0 broadcast first so V3 can reference it
            let v0Result = await broadcastHelper.sendBroadcastV0(broadcastAddress, "BROADCAST v3 feed", 1)
            assert(v0Result.broadcast, "Broadcast v0 (for v3 reference) should exist in DB")
            let broadcastV0ActionIndex = Number(v0Result.broadcast["action_index"])

            let result = await broadcastHelper.sendBroadcastV3(
                broadcastAddress, broadcastV0ActionIndex, 0.01, "Memo test for BROADCAST v3"
            )
            assert(result.broadcast, "Broadcast v3 should exist in DB")
        })
    })
})
