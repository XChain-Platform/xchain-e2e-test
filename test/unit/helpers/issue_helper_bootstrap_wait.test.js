'use strict'

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
const fs = require('fs')
const path = require('path')

const addressInfo = { address: 'bootstrap-address' }
const transactionCalls = []
const transactionHelper = {
    async createAndSendTransaction(...args) {
        transactionCalls.push(args)
        return 'bootstrap-tx'
    }
}

const transactionHelperPath = require.resolve('../../helpers/core/transactionHelper')
const issueHelperPath = require.resolve('../../helpers/issueHelper')
const cachedTransactionHelper = require.cache[transactionHelperPath]
const cachedIssueHelper = require.cache[issueHelperPath]
require.cache[transactionHelperPath] = {
    id: transactionHelperPath,
    filename: transactionHelperPath,
    loaded: true,
    exports: transactionHelper
}
delete require.cache[issueHelperPath]
const issueHelper = require(issueHelperPath)
if(cachedTransactionHelper) require.cache[transactionHelperPath] = cachedTransactionHelper
else delete require.cache[transactionHelperPath]
if(cachedIssueHelper) require.cache[issueHelperPath] = cachedIssueHelper
else delete require.cache[issueHelperPath]

function asyncStub(result) {
    const stub = async function (...args) {
        stub.calls.push(args)
        return result
    }
    stub.calls = []
    return stub
}

describe('bootstrap ISSUE wait budget', function () {
    beforeEach(function () {
        transactionCalls.length = 0
        global.indexerDatabase = {
            waitForIssue: asyncStub({ id: 1 }),
            waitForCredit: asyncStub({ id: 2 })
        }
    })

    afterEach(function () {
        delete global.indexerDatabase
    })

    it('passes 240000 ms to both bootstrap database waits', async function () {
        await issueHelper.sendIssueV0Waiting(
            240000, addressInfo, 'XCHAIN', 100000000, 100000, 0, 'XChain GAS Token', 0
        )

        assert.strictEqual(global.indexerDatabase.waitForIssue.calls[0][1], 240000)
        assert.strictEqual(global.indexerDatabase.waitForCredit.calls[0][1], 240000)
        assert.strictEqual(transactionCalls.length, 1)
    })

    it('leaves the default helper without a wait override', async function () {
        await issueHelper.sendIssueV0(
            addressInfo, 'OTHER', 1000, 100, 0, 'Other token', 0
        )

        assert.strictEqual(global.indexerDatabase.waitForIssue.calls[0].length, 1)
        assert.strictEqual(global.indexerDatabase.waitForCredit.calls[0].length, 1)
    })

    it('uses the bootstrap wait constant in the BTC gas-token check', function () {
        const source = fs.readFileSync(path.join(__dirname, '../../initial_check.test.js'), 'utf8')

        assert.match(source, /const BOOTSTRAP_ISSUE_WAIT_MS = 240000/)
        assert.match(source, /sendIssueV0Waiting\(\s*BOOTSTRAP_ISSUE_WAIT_MS,\s*gasAddressInfo,/)
    })
})
