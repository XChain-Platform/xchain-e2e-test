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
const transactionHelper = require('../transactionHelper')

describe('NEGATIVE', () => {
    describe('SEND - insufficient balance', () => {
        it('should reject a send with insufficient balance', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("NEG.SEND.BAL", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "NEGSENDbal"+address.substring(address.length-8)

            // mintSupply=10; the SEND below tries 50
            await issueHelper.sendIssueV0(addr, tick, 100, 50, 0, "Neg send test", 10)

            let dest = await cryptoHelper.getNewAddress("NEG.SEND.DEST", COIN, NETWORK, null, "legacy", 0)

            let sendMessage = "SEND|0|"+tick+"|50|"+dest["address"]+"|insufficient test"
            let txHash = await transactionHelper.createAndSendTransaction(addr, sendMessage)

            let invalidSend = await indexerDatabase.waitForSend({
                txHash: txHash,
                source: address,
                status: "invalid: insufficient funds"
            }, 30000)
            assert(invalidSend, "Send should be rejected with insufficient funds")
        })
    })

    describe('ISSUE - non-owner edit', () => {
        it('should reject an issue edit from a non-owner address', async () => {
            let owner = await cryptoHelper.getNewFundedAddress("NEG.ISSUE.OWNER", COIN, NETWORK, null, "legacy", 0, 1)
            let other = await cryptoHelper.getNewFundedAddress("NEG.ISSUE.OTHER", COIN, NETWORK, null, "legacy", 0, 1)
            let tick = "NEGISSown"+owner["address"].substring(owner["address"].length-8)

            await issueHelper.sendIssueV0(owner, tick, 100, 50, 0, "Neg issue owner test", 50)

            // ISSUE v1 edit from a different address must be rejected
            let issueMessage = "ISSUE|1|"+tick+"|Hijacked description"
            let txHash = await transactionHelper.createAndSendTransaction(other, issueMessage)

            let invalidIssue = await indexerDatabase.waitForIssue({
                txHash: txHash,
                tick: tick,
                status: "invalid: issued by another address"
            }, 30000)
            assert(invalidIssue, "Issue edit should be rejected from non-owner")
        })
    })

    describe('SEND - unknown tick', () => {
        it('should reject a send with a non-existent token', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("NEG.SEND.TICK", COIN, NETWORK, null, "legacy", 0, 1)
            let dest = await cryptoHelper.getNewAddress("NEG.SEND.TICK.DEST", COIN, NETWORK, null, "legacy", 0)

            let sendMessage = "SEND|0|DOESNOTEXIST999|10|"+dest["address"]+"|unknown tick test"
            let txHash = await transactionHelper.createAndSendTransaction(addr, sendMessage)

            let invalidSend = await indexerDatabase.waitForSend({
                txHash: txHash,
                source: addr["address"],
                status: "invalid: TICK (unknown)"
            }, 30000)
            assert(invalidSend, "Send should be rejected with unknown tick")
        })
    })

    describe('SEND - invalid amount format', () => {
        it('should reject a send with decimals on an indivisible token', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("NEG.SEND.AMT", COIN, NETWORK, null, "legacy", 0, 1)
            let address = addr["address"]
            let tick = "NEGSNDamt"+address.substring(address.length-8)

            // decimals=0 (indivisible); the SEND below uses a fractional amount
            await issueHelper.sendIssueV0(addr, tick, 100, 50, 0, "Neg amount test", 50)

            let dest = await cryptoHelper.getNewAddress("NEG.SEND.AMT.DEST", COIN, NETWORK, null, "legacy", 0)

            let sendMessage = "SEND|0|"+tick+"|1.5|"+dest["address"]+"|bad amount test"
            let txHash = await transactionHelper.createAndSendTransaction(addr, sendMessage)

            let invalidSend = await indexerDatabase.waitForSend({
                txHash: txHash,
                source: address,
                status: "invalid: AMOUNT (format)"
            }, 30000)
            assert(invalidSend, "Send with decimal amount on indivisible token should be rejected")
        })
    })
})
