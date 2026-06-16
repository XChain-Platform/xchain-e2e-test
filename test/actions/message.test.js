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
const messageHelper = require('../helpers/messageHelper')

describe('MESSAGE', () => {
    describe('v0 - sender key', () => {
        it('should send a sender key exchange v0', async () => {
            let senderAddr = await cryptoHelper.getNewFundedAddress("MESSAGE.V0", COIN, NETWORK, null, "legacy", 0, 1)
            let destAddr = await cryptoHelper.getNewAddress("MESSAGE.V0.DEST", COIN, NETWORK, null, "legacy", 0)

            // Use the sender's public key (hex) for ECDH key exchange
            let result = await messageHelper.sendMessageV0(
                senderAddr,
                destAddr["address"],
                1,
                senderAddr["publicKey"].toString('hex')
            )
            assert(result.message, "Message v0 (sender key) should exist in DB")
        })
    })

    describe('v1 - receiver key', () => {
        it('should complete a key exchange with v0 and v1', async () => {
            let senderAddr = await cryptoHelper.getNewFundedAddress("MESSAGE.V1.SENDER", COIN, NETWORK, null, "legacy", 0, 1)
            let receiverAddr = await cryptoHelper.getNewFundedAddress("MESSAGE.V1.RECEIVER", COIN, NETWORK, null, "legacy", 0, 1)

            // Sender initiates key exchange
            let v0Result = await messageHelper.sendMessageV0(
                senderAddr,
                receiverAddr["address"],
                1,
                senderAddr["publicKey"].toString('hex')
            )
            assert(v0Result.message, "Message v0 should exist in DB")

            // Receiver responds with their key
            let v1Result = await messageHelper.sendMessageV1(
                receiverAddr,
                senderAddr["address"],
                1,
                receiverAddr["publicKey"].toString('hex')
            )
            assert(v1Result.message, "Message v1 (receiver key) should exist in DB")
        })
    })

    describe('v2 - encrypted message', () => {
        it('should send an encrypted message v2', async () => {
            let senderAddr = await cryptoHelper.getNewFundedAddress("MESSAGE.V2.SENDER", COIN, NETWORK, null, "legacy", 0, 1)
            let receiverAddr = await cryptoHelper.getNewFundedAddress("MESSAGE.V2.RECEIVER", COIN, NETWORK, null, "legacy", 0, 1)

            // Key exchange first
            await messageHelper.sendMessageV0(
                senderAddr,
                receiverAddr["address"],
                1,
                senderAddr["publicKey"].toString('hex')
            )
            await messageHelper.sendMessageV1(
                receiverAddr,
                senderAddr["address"],
                1,
                receiverAddr["publicKey"].toString('hex')
            )

            // Send encrypted message (simulated encrypted content)
            let result = await messageHelper.sendMessageV2(
                senderAddr,
                receiverAddr["address"],
                "encrypted_test_message_content_here"
            )
            assert(result.message, "Message v2 (encrypted) should exist in DB")
        })
    })

    describe('v3 - plaintext', () => {
        it('should send a plaintext message v3', async () => {
            let senderAddr = await cryptoHelper.getNewFundedAddress("MESSAGE.V3", COIN, NETWORK, null, "legacy", 0, 1)
            let destAddr = await cryptoHelper.getNewAddress("MESSAGE.V3.DEST", COIN, NETWORK, null, "legacy", 0)

            let result = await messageHelper.sendMessageV3(
                senderAddr,
                destAddr["address"],
                "Hello from XChain e2e test"
            )
            assert(result.message, "Message v3 should exist in DB")
        })
    })
})
