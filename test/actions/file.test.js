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
const fileHelper = require('../helpers/fileHelper')

describe('FILE', () => {
    describe('v0', () => {
        it('should upload a file v0', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("FILE.V0", COIN, NETWORK, null, "legacy", 0, 1)

            let result = await fileHelper.sendFileV0(
                addr,
                "test.txt",
                "text/plain",
                "E2E Test File",
                "File upload test memo",
                "SGVsbG8gV29ybGQ=" // base64 "Hello World"
            )
            assert(result.file, "File v0 should exist in DB")
        })
    })
})
