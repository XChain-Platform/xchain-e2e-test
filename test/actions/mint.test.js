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
const mintHelper = require('../helpers/mintHelper')

describe('MINT', () => {
    describe('v0', () => {
        it('should create a MINT v0', async () => {
            let issuerAddress = await cryptoHelper.getNewFundedAddress("MINT.V0.ISSUER", COIN, NETWORK, null, "legacy", 0, 1)
            let mintDestination = await cryptoHelper.getNewAddress("MINT.V0.DEST", COIN, NETWORK, null, "legacy", 0)
            let tick = "MINTv0"+issuerAddress["address"].substring(issuerAddress["address"].length-8)

            let issueResult = await issueHelper.sendIssueV0(issuerAddress, tick, 100, 2, 0, "MINT test token", 10)
            assert(issueResult.issue, "Issue for MINT should exist in DB")

            let mintResult = await mintHelper.sendMintV0(
                issuerAddress, tick, 2, mintDestination["address"], "A simple MINT test v0"
            )
            assert(mintResult.mint, "Mint v0 should exist in DB")
            assert(mintResult.credit, "Mint v0 credit should exist in DB")
        })
    })
})
