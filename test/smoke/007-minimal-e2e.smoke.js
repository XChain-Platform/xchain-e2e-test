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
const sendHelper = require('../helpers/sendHelper')

describe('SMOKE: Minimal E2E: ISSUE + SEND', () => {
    it('should issue a token and send it to another address', async () => {
        const senderAddress = await cryptoHelper.getNewFundedAddress(
            'SMOKE.E2E', COIN, NETWORK, null, 'legacy', 0, 1
        )
        const destAddress = await cryptoHelper.getNewAddress(
            'SMOKE.E2E.DEST', COIN, NETWORK, null, 'legacy', 0
        )

        const tick = 'SMOKE' + senderAddress.address.substring(senderAddress.address.length - 7)

        const issueResult = await issueHelper.sendIssueV0(
            senderAddress, tick, 100, 10, 0, 'Smoke test token', 10
        )
        assert(issueResult.issue, 'Issue should exist in DB')
        assert(issueResult.credit, 'Issue credit should exist in DB')

        const sendResult = await sendHelper.sendSendV0(
            senderAddress, tick, 1, destAddress.address, 'Smoke test send'
        )
        assert(sendResult.send, 'Send should exist in DB')
        assert(sendResult.credit, 'Send credit should exist in DB')
        assert(sendResult.debit, 'Send debit should exist in DB')
    })
})
