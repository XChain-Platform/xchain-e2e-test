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
const sleepHelper = require('../helpers/sleepHelper')

describe('SLEEP', () => {
    describe('v0 - address sleep', () => {
        it('should sleep an address v0', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("SLEEP.V0", COIN, NETWORK, null, "legacy", 0, 1)

            // Sleep until a very far future block
            let result = await sleepHelper.sendSleepV0(addr, 999999, "Sleep address test")
            assert(result.sleep, "Sleep v0 should exist in DB")
        })
    })

    describe('v1 - tick sleep', () => {
        it('should sleep a tick v1', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("SLEEP.V1", COIN, NETWORK, null, "legacy", 0, 1)
            let tick = "SLEEPv1"+addr["address"].substring(addr["address"].length-8)

            // Create a token first
            await issueHelper.sendIssueV0(addr, tick, 100, 10, 0, "Sleep v1 test token", 10)

            // Sleep the tick (use -1 for indefinite sleep)
            let result = await sleepHelper.sendSleepV1(addr, -1, tick, "Sleep tick test")
            assert(result.sleep, "Sleep v1 should exist in DB")
        })
    })
})
