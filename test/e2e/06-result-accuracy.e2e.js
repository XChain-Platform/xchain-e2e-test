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
const issueHelper = require('../helpers/issueHelper')
const sendHelper = require('../helpers/sendHelper')
const mintHelper = require('../helpers/mintHelper')

// MANUAL VERIFICATION REQUIRED:
// E2E-REPORT-002 (broken encoder): Swap encoder URL for a stub service that
//   returns malformed PSBTs, verify affected tests fail with descriptive errors

describe('E2E: Result Accuracy & Reporting Fidelity', () => {
    describe('E2E-REPORT-001: Assertion accuracy when services function correctly', () => {
        it('should produce all correct assertions for a complete ISSUE+SEND flow', async () => {
            const addr = await cryptoHelper.getNewFundedAddress('E2E.REPORT.PASS', COIN, NETWORK, null, 'legacy', 0, 1)
            const dest = await cryptoHelper.getNewAddress('E2E.REPORT.DEST', COIN, NETWORK, null, 'legacy', 0)
            const tick = 'E2ERPT' + addr.address.substring(addr.address.length - 8)

            // ISSUE
            const issueResult = await issueHelper.sendIssueV0(addr, tick, 100, 10, 0, 'report accuracy test', 10)
            assert(issueResult.issue, 'Issue DB record must be truthy')
            assert(issueResult.credit, 'Issue credit DB record must be truthy')
            assert.strictEqual(issueResult.issue.status, 'valid', 'Issue status must be valid')
            assert.strictEqual(issueResult.issue.tick, tick, 'Issue tick must match')
            assert.strictEqual(Number(issueResult.issue.max_supply), 100, 'Issue max_supply must match')
            assert.strictEqual(Number(issueResult.issue.max_mint), 10, 'Issue max_mint must match')
            assert.strictEqual(Number(issueResult.issue.decimals), 0, 'Issue decimals must match')
            assert.strictEqual(issueResult.issue.description, 'report accuracy test', 'Issue description must match')
            assert.strictEqual(Number(issueResult.issue.mint_supply), 10, 'Issue mint_supply must match')
            assert.strictEqual(Number(issueResult.credit.amount), 10, 'Credit amount must match mintSupply')
            assert.strictEqual(issueResult.credit.address, addr.address, 'Credit address must be issuer')

            // SEND
            const sendResult = await sendHelper.sendSendV0(addr, tick, 3, dest.address, 'report test send')
            assert(sendResult.send, 'Send DB record must be truthy')
            assert(sendResult.credit, 'Send credit must be truthy')
            assert(sendResult.debit, 'Send debit must be truthy')
            assert.strictEqual(sendResult.send.status, 'valid', 'Send status must be valid')
            assert.strictEqual(Number(sendResult.send.amount), 3, 'Send amount must be 3')
            assert.strictEqual(sendResult.send.source, addr.address, 'Send source must be sender')
            assert.strictEqual(sendResult.send.destination, dest.address, 'Send destination must be receiver')
            assert.strictEqual(sendResult.credit.address, dest.address, 'Credit must go to destination')
            assert.strictEqual(Number(sendResult.credit.amount), 3, 'Credit amount must match')
            assert.strictEqual(sendResult.debit.address, addr.address, 'Debit must come from sender')
            assert.strictEqual(Number(sendResult.debit.amount), 3, 'Debit amount must match')
        })

        it('should confirm that MINT credits the destination, not the issuer', async () => {
            const issuerAddr = await cryptoHelper.getNewFundedAddress('E2E.REPORT.MINT', COIN, NETWORK, null, 'legacy', 0, 1)
            const mintDest = await cryptoHelper.getNewAddress('E2E.REPORT.MINT.DEST', COIN, NETWORK, null, 'legacy', 0)
            const tick = 'E2EMRPT' + issuerAddr.address.substring(issuerAddr.address.length - 6)

            // Create token with mintable supply
            await issueHelper.sendIssueV0(issuerAddr, tick, 200, 20, 0, 'mint report test', 10)

            // Mint to the destination address (not the issuer)
            const mintResult = await mintHelper.sendMintV0(issuerAddr, tick, 20, mintDest.address, 'e2e mint report')
            assert(mintResult.mint, 'Mint DB record must be truthy')
            assert.strictEqual(mintResult.mint.status, 'valid', 'Mint status must be valid')
            assert(mintResult.credit, 'Mint credit must be truthy')
            assert.strictEqual(mintResult.credit.address, mintDest.address,
                'Mint credit must go to destination, not issuer')
            assert(mintResult.credit.address !== issuerAddr.address,
                'Mint credit address must differ from issuer address')
            assert.strictEqual(Number(mintResult.credit.amount), 20, 'Mint credit amount must match')
        })
    })

    describe('E2E-REPORT-003: No false positives when polling times out', () => {
        it('should produce null from waitForIssue on a non-existent tick', async () => {
            const fakeTick = 'NVREXST' + Date.now().toString().slice(-7)
            const result = await indexerDatabase.waitForIssue({ tick: fakeTick, status: 'valid' }, 2000)

            assert.strictEqual(result, null, 'waitForIssue should return null for non-existent tick')

            // Prove that assert(null) would throw — no silent pass path is possible
            let assertionThrew = false
            try {
                assert(result, 'Should not be truthy')
            } catch (e) {
                assertionThrew = true
                assert(e instanceof assert.AssertionError, 'Exception must be AssertionError')
            }
            assert(assertionThrew, 'assert(null) must throw — guaranteeing no false positive')
        })

        it('should produce null from waitForSend on a non-existent txHash', async () => {
            const fakeTxHash = 'a'.repeat(64)
            const result = await indexerDatabase.waitForSend({ txHash: fakeTxHash, status: 'valid' }, 2000)

            assert.strictEqual(result, null, 'waitForSend should return null for non-existent txHash')

            let assertionThrew = false
            try {
                assert(result, 'Should not be truthy')
            } catch (e) {
                assertionThrew = true
            }
            assert(assertionThrew, 'assert(null) must throw — guaranteeing no false positive for sends')
        })

        it('should produce null from waitForCredit on a non-existent txHash', async () => {
            const fakeTxHash = 'b'.repeat(64)
            const result = await indexerDatabase.waitForCredit({ txHash: fakeTxHash }, 2000)
            assert.strictEqual(result, null, 'waitForCredit should return null for non-existent txHash')
        })
    })
})
