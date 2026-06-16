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
const fileHelper = require('../helpers/fileHelper')
const linkHelper = require('../helpers/linkHelper')

describe('LINK', () => {
    describe('v0', () => {
        it('should link two actions v0', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("LINK.V0", COIN, NETWORK, null, "legacy", 0, 1)

            // Create two actions to link (an issue and a file)
            let issueResult = await issueHelper.sendIssueV0(
                addr, "LINKv0"+addr["address"].substring(addr["address"].length-8),
                100, 10, 0, "Link test token", 10
            )
            assert(issueResult.issue, "Issue for link should exist")
            let issueActionIndex = Number(issueResult.issue["action_index"])

            let fileResult = await fileHelper.sendFileV0(
                addr, "link-test.txt", "text/plain", "Link test file", "Link file memo",
                "TGluayB0ZXN0IGZpbGU=" // base64 "Link test file"
            )
            assert(fileResult.file, "File for link should exist")
            let fileActionIndex = Number(fileResult.file["action_index"])

            // Link the two actions
            let result = await linkHelper.sendLinkV0(
                addr,
                COIN_CODE, issueActionIndex,
                COIN_CODE, fileActionIndex,
                "Linking issue to file"
            )
            assert(result.link, "Link v0 should exist in DB")
        })
    })
})
