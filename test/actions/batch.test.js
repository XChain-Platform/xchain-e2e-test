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
const batchHelper = require('../helpers/batchHelper')

describe('BATCH', () => {
    describe('v0', () => {
        it('should execute a batch of SEND commands', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("BATCH.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "BATCHv0"+address.substring(address.length-8)

            // Create a token
            await issueHelper.sendIssueV0(addr, tick, 100, 50, 0, "Batch test token", 50)

            // Create destination addresses
            let dest1 = await cryptoHelper.getNewAddress("BATCH.V0", COIN, NETWORK, null, "legacy", 1)
            let dest2 = await cryptoHelper.getNewAddress("BATCH.V0", COIN, NETWORK, null, "legacy", 2)

            // Batch: two SENDs
            let result = await batchHelper.sendBatchV0(addr, [
                "SEND|0|"+tick+"|1|"+dest1["address"]+"|Batch send 1",
                "SEND|0|"+tick+"|2|"+dest2["address"]+"|Batch send 2"
            ])
            assert(result.batch, "Batch v0 should exist in DB")

            // Verify the individual sends were processed
            let send1 = await indexerDatabase.waitForSend({
                source: address,
                destination: dest1["address"],
                tick: tick,
                amount: 1,
                status: "valid"
            })
            assert(send1, "First batched send should exist in DB")

            let send2 = await indexerDatabase.waitForSend({
                source: address,
                destination: dest2["address"],
                tick: tick,
                amount: 2,
                status: "valid"
            })
            assert(send2, "Second batched send should exist in DB")
        })
    })
})
