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

describe('SEND', () => {
    describe('v0', () => {
        it('should create a SEND Message v0', async () => {
            let senderAddress = await cryptoHelper.getNewFundedAddress("SEND.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let destAddress = await cryptoHelper.getNewAddress("SEND.V0.DEST", COIN, NETWORK, null, "legacy", 0)
            let tick = "SENDv0"+senderAddress["address"].substring(senderAddress["address"].length-8)

            await issueHelper.sendIssueV0(senderAddress, tick, 100, 2, 0, "SEND v0 test token", 10)

            let result = await sendHelper.sendSendV0(senderAddress, tick, 1, destAddress["address"], "A simple SEND test v0")
            assert(result.send, "Send v0 should exist in DB")
            assert(result.credit, "Send v0 credit should exist in DB")
            assert(result.debit, "Send v0 debit should exist in DB")
        })
    })

    describe('v1', () => {
        it('should create a SEND Message v1', async () => {
            let senderAddress = await cryptoHelper.getNewFundedAddress("SEND.V1", COIN, NETWORK, null, "legacy", 0, 1)
            let destAddress1 = await cryptoHelper.getNewAddress("SEND.V1.DEST1", COIN, NETWORK, null, "legacy", 0)
            let destAddress2 = await cryptoHelper.getNewAddress("SEND.V1.DEST2", COIN, NETWORK, null, "legacy", 0)
            let tick = "SENDv1"+senderAddress["address"].substring(senderAddress["address"].length-8)

            await issueHelper.sendIssueV0(senderAddress, tick, 100, 5, 0, "SEND v1 test token", 20)

            let result = await sendHelper.sendSendV1(senderAddress, tick, 1, destAddress1["address"], 2, destAddress2["address"], "A simple SEND test v1")
            assert(result.send1, "Send v1 first send should exist in DB")
            assert(result.send2, "Send v1 second send should exist in DB")
            assert(result.credit1, "Send v1 first credit should exist in DB")
            assert(result.credit2, "Send v1 second credit should exist in DB")
            assert(result.debit, "Send v1 debit should exist in DB")
        })
    })

    describe('v2', () => {
        it('should create a SEND Message v2', async () => {
            let senderAddress = await cryptoHelper.getNewFundedAddress("SEND.V2", COIN, NETWORK, null, "legacy", 0, 1)
            let destAddress1 = await cryptoHelper.getNewAddress("SEND.V2.DEST1", COIN, NETWORK, null, "legacy", 0)
            let destAddress2 = await cryptoHelper.getNewAddress("SEND.V2.DEST2", COIN, NETWORK, null, "legacy", 0)
            let tick1 = "SENDv2a"+senderAddress["address"].substring(senderAddress["address"].length-7)
            let tick2 = "SENDv2b"+senderAddress["address"].substring(senderAddress["address"].length-7)

            await issueHelper.sendIssueV0(senderAddress, tick1, 100, 2, 0, "SEND v2 test token 1", 10)
            await issueHelper.sendIssueV0(senderAddress, tick2, 100, 5, 0, "SEND v2 test token 2", 20)

            let result = await sendHelper.sendSendV2(senderAddress, tick1, 1, destAddress1["address"], tick2, 2, destAddress2["address"], "A simple SEND test v2")
            assert(result.send1, "Send v2 first send should exist in DB")
            assert(result.send2, "Send v2 second send should exist in DB")
            assert(result.credit1, "Send v2 first credit should exist in DB")
            assert(result.credit2, "Send v2 second credit should exist in DB")
            assert(result.debit1, "Send v2 first debit should exist in DB")
            assert(result.debit2, "Send v2 second debit should exist in DB")
        })
    })

    describe('v3', () => {
        it('should create a SEND Message v3', async () => {
            let senderAddress = await cryptoHelper.getNewFundedAddress("SEND.V3", COIN, NETWORK, null, "legacy", 0, 1)
            let destAddress1 = await cryptoHelper.getNewAddress("SEND.V3.DEST1", COIN, NETWORK, null, "legacy", 0)
            let destAddress2 = await cryptoHelper.getNewAddress("SEND.V3.DEST2", COIN, NETWORK, null, "legacy", 0)
            let tick1 = "SENDv3a"+senderAddress["address"].substring(senderAddress["address"].length-7)
            let tick2 = "SENDv3b"+senderAddress["address"].substring(senderAddress["address"].length-7)

            await issueHelper.sendIssueV0(senderAddress, tick1, 100, 2, 0, "SEND v3 test token 1", 10)
            await issueHelper.sendIssueV0(senderAddress, tick2, 100, 5, 0, "SEND v3 test token 2", 20)

            let result = await sendHelper.sendSendV3(senderAddress, tick1, 1, destAddress1["address"], "1st SEND test v3", tick2, 2, destAddress2["address"], "2nd SEND test v3")
            assert(result.send1, "Send v3 first send should exist in DB")
            assert(result.send2, "Send v3 second send should exist in DB")
            assert(result.credit1, "Send v3 first credit should exist in DB")
            assert(result.credit2, "Send v3 second credit should exist in DB")
            assert(result.debit1, "Send v3 first debit should exist in DB")
            assert(result.debit2, "Send v3 second debit should exist in DB")
        })
    })
})
