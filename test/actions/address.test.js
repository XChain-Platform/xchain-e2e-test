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
const addressHelper = require('../helpers/addressHelper')

describe('ADDRESS', () => {
    describe('v0', () => {
        it('should set address options v0', async () => {
            let addrInfo = await cryptoHelper.getNewFundedAddress("ADDRESS.V0", COIN, NETWORK, null, "legacy", 0, 1)

            let result = await addressHelper.sendAddressV0(
                addrInfo,
                1, // feePreference: 1=destroyed
                0, // requireMemo: 0=not required
                "Address options test"
            )
            assert(result.addressOption, "Address option v0 should exist in DB")
        })
    })
})
