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
const transactionHelper = require('../transactionHelper')
const issueHelper = require('../helpers/issueHelper')
const sendHelper = require('../helpers/sendHelper')
const batchHelper = require('../helpers/batchHelper')

describe('E2E: Action Flow Orchestration', () => {
    describe('E2E-EXEC-003: Sequential issue-then-send dependency chain', () => {
        let addr, tick, issueResult

        it('should issue a token and verify full cross-table DB state', async () => {
            addr = await cryptoHelper.getNewFundedAddress('E2E.FLOW.ISSUE', COIN, NETWORK, null, 'legacy', 0, 1)
            tick = 'E2EFLOW' + addr.address.substring(addr.address.length - 7)

            issueResult = await issueHelper.sendIssueV0(addr, tick, 100, 10, 0, 'E2E flow test', 10)

            assert(issueResult.txHash, 'txHash should be returned')
            assert.strictEqual(issueResult.txHash.length, 64, 'txHash should be 64-char hex')

            // Issue record assertions
            assert(issueResult.issue, 'Issue DB record should exist')
            assert.strictEqual(issueResult.issue.tick, tick, 'Issue tick should match')
            assert.strictEqual(issueResult.issue.status, 'valid', 'Issue status should be valid')

            // Credit record assertions
            assert(issueResult.credit, 'Issue credit DB record should exist')
            assert.strictEqual(issueResult.credit.address, addr.address, 'Credit should go to issuer')
            assert.strictEqual(issueResult.credit.tick, tick, 'Credit tick should match')
            assert.strictEqual(Number(issueResult.credit.amount), 10, 'Credit amount should match mintSupply')

            // Cross-table consistency
            assert.strictEqual(issueResult.issue.tx_hash, issueResult.credit.tx_hash,
                'Issue and credit tx_hash should match (same transaction)')
        })

        it('should send the issued token and produce correct debit and credit records', async () => {
            const dest = await cryptoHelper.getNewAddress('E2E.FLOW.DEST', COIN, NETWORK, null, 'legacy', 0)

            const sendResult = await sendHelper.sendSendV0(addr, tick, 5, dest.address, 'e2e flow send')

            assert(sendResult.txHash, 'Send txHash should be returned')
            assert(sendResult.txHash !== issueResult.txHash, 'Send txHash should differ from issue txHash')

            // Send record assertions
            assert(sendResult.send, 'Send DB record should exist')
            assert.strictEqual(sendResult.send.status, 'valid', 'Send status should be valid')
            assert.strictEqual(sendResult.send.tick, tick, 'Send tick should match')
            assert.strictEqual(Number(sendResult.send.amount), 5, 'Send amount should be 5')
            assert.strictEqual(sendResult.send.source, addr.address, 'Send source should be sender')
            assert.strictEqual(sendResult.send.destination, dest.address, 'Send destination should be receiver')

            // Credit for receiver
            assert(sendResult.credit, 'Send credit should exist')
            assert.strictEqual(sendResult.credit.address, dest.address, 'Credit should go to destination')
            assert.strictEqual(Number(sendResult.credit.amount), 5, 'Credit amount should match send amount')
            assert.strictEqual(sendResult.credit.tick, tick, 'Credit tick should match')

            // Debit for sender
            assert(sendResult.debit, 'Send debit should exist')
            assert.strictEqual(sendResult.debit.address, addr.address, 'Debit should come from sender')
            assert.strictEqual(Number(sendResult.debit.amount), 5, 'Debit amount should match send amount')

            // Cross-table consistency
            assert.strictEqual(sendResult.send.tx_hash, sendResult.credit.tx_hash,
                'Send and credit tx_hash should match')
            assert.strictEqual(sendResult.send.tx_hash, sendResult.debit.tx_hash,
                'Send and debit tx_hash should match')
        })
    })

    describe('E2E-EXEC-004: Negative status detection', () => {
        it('should detect an ISSUE edit from a non-owner with invalid status', async () => {
            const owner = await cryptoHelper.getNewFundedAddress('E2E.NEG.OWNER', COIN, NETWORK, null, 'legacy', 0, 1)
            const other = await cryptoHelper.getNewFundedAddress('E2E.NEG.OTHER', COIN, NETWORK, null, 'legacy', 0, 1)
            const tick = 'E2ENEG' + owner.address.substring(owner.address.length - 8)

            // Owner creates the token
            await issueHelper.sendIssueV0(owner, tick, 100, 10, 0, 'neg test', 10)

            // Non-owner tries to edit description
            const badMessage = 'ISSUE|1|' + tick + '|Hijacked description'
            const txHash = await transactionHelper.createAndSendTransaction(other, badMessage)

            const invalidRow = await indexerDatabase.waitForIssue({
                txHash: txHash,
                tick: tick,
                status: 'invalid: issued by another address'
            }, 60000)
            assert(invalidRow, 'Invalid issue edit should be recorded in DB')
            assert.strictEqual(invalidRow.status, 'invalid: issued by another address', 'Status should indicate non-owner rejection')

            // Original issue should remain valid
            const originalIssue = await indexerDatabase.checkIssue({ tick: tick, source: owner.address, status: 'valid' })
            assert(originalIssue, 'Original valid issue should still exist')
        })

        it('should detect a SEND with insufficient funds as invalid', async () => {
            const addr = await cryptoHelper.getNewFundedAddress('E2E.NEG.SEND', COIN, NETWORK, null, 'legacy', 0, 1)
            const tick = 'E2ENEGS' + addr.address.substring(addr.address.length - 7)

            // Create token with only 10 supply
            await issueHelper.sendIssueV0(addr, tick, 100, 10, 0, 'neg send test', 10)

            const dest = await cryptoHelper.getNewAddress('E2E.NEG.SEND.DEST', COIN, NETWORK, null, 'legacy', 0)

            // Try to send 999 when we only have 10
            const sendMessage = 'SEND|0|' + tick + '|999|' + dest.address + '|overspend'
            const txHash = await transactionHelper.createAndSendTransaction(addr, sendMessage)

            const invalidSend = await indexerDatabase.waitForSend({
                txHash: txHash,
                source: addr.address,
                status: 'invalid: insufficient funds'
            }, 60000)
            assert(invalidSend, 'Send should be rejected with insufficient funds')
            assert.strictEqual(invalidSend.status, 'invalid: insufficient funds')

            // No credit should exist for invalid sends
            const noCredit = await indexerDatabase.checkCredit({ txHash: txHash, address: dest.address })
            assert(!noCredit, 'No credit should be created for an invalid send')
        })
    })

    describe('E2E-EXEC-005: Batch action unpacking', () => {
        it('should process a batch of two SENDs and expose individual send records', async () => {
            const addr = await cryptoHelper.getNewFundedAddress('E2E.BATCH', COIN, NETWORK, null, 'legacy', 0, 1)
            const tick = 'E2EBATCH' + addr.address.substring(addr.address.length - 6)

            // Create token with enough supply for batch sends
            await issueHelper.sendIssueV0(addr, tick, 100, 50, 0, 'batch e2e test', 50)

            const dest1 = await cryptoHelper.getNewAddress('E2E.BATCH', COIN, NETWORK, null, 'legacy', 1)
            const dest2 = await cryptoHelper.getNewAddress('E2E.BATCH', COIN, NETWORK, null, 'legacy', 2)

            const batchResult = await batchHelper.sendBatchV0(addr, [
                'SEND|0|' + tick + '|1|' + dest1.address + '|batch e2e 1',
                'SEND|0|' + tick + '|2|' + dest2.address + '|batch e2e 2'
            ])

            assert(batchResult.batch, 'Batch DB record should exist')
            assert.strictEqual(batchResult.batch.status, 'valid', 'Batch status should be valid')
            assert(batchResult.txHash, 'Batch txHash should be returned')
            assert.strictEqual(batchResult.txHash.length, 64, 'Batch txHash should be 64-char hex')

            // Verify individual send records
            const send1 = await indexerDatabase.waitForSend({
                source: addr.address,
                destination: dest1.address,
                tick: tick,
                amount: 1,
                status: 'valid'
            }, 60000)
            assert(send1, 'First batched send should exist in DB')
            assert.strictEqual(send1.tx_hash, batchResult.txHash, 'First send tx_hash should match batch tx_hash')

            const send2 = await indexerDatabase.waitForSend({
                source: addr.address,
                destination: dest2.address,
                tick: tick,
                amount: 2,
                status: 'valid'
            }, 60000)
            assert(send2, 'Second batched send should exist in DB')
            assert.strictEqual(send2.tx_hash, batchResult.txHash, 'Second send tx_hash should match batch tx_hash')

            // Sub-actions should have distinct action indices
            assert(send1.action_index !== send2.action_index,
                'Batched sends should have distinct action_index values')
        })
    })
})
