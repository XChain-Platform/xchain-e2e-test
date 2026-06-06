'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon = require('sinon')
const assert = require('assert')
const transactionHelper = require('../../transactionHelper')
const helper = require('../../helpers/issueHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('issueHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForIssue: sinon.stub().resolves({ id: 1 }),
            waitForCredit: sinon.stub().resolves({ id: 2 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendIssueV0', () => {
        it('should build correct message with required params', async () => {
            const result = await helper.sendIssueV0(
                addressInfo, 'MYTOKEN', '1000', '100', '8', 'My Token', '50'
            )

            const msg = createTxStub.firstCall.args[1]
            // 17 optional params all default to '' → 17 trailing pipes after mintSupply
            assert.strictEqual(msg, 'ISSUE|0|MYTOKEN|1000|100|8|My Token|50|||||||||||||||||')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.issue, { id: 1 })
            assert.deepStrictEqual(result.credit, { id: 2 })
        })

        it('should build correct message with all optional params', async () => {
            const result = await helper.sendIssueV0(
                addressInfo, 'TOK', '2000', '200', '4', 'desc', '100',
                '1', '50', 'lockMax', 'lockMint', 'lockDesc',
                'lockSleep', 'lockCb', '500', 'CBTOKEN', '10',
                'allow1', 'block1', '5', '100', '200', 'lockMintFlag', 'lockMintSup'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg,
                'ISSUE|0|TOK|2000|200|4|desc|100|1|50|lockMax|lockMint|lockDesc|lockSleep|lockCb|500|CBTOKEN|10|allow1|block1|5|100|200|lockMintFlag|lockMintSup'
            )
            assert.strictEqual(result.txHash, 'abc123')
        })

        it('should call waitForIssue and waitForCredit', async () => {
            await helper.sendIssueV0(addressInfo, 'TOK', '1000', '100', '8', 'desc', '50')
            assert(global.indexerDatabase.waitForIssue.calledOnce)
            assert(global.indexerDatabase.waitForCredit.calledOnce)
        })
    })

    describe('sendIssueV1', () => {
        it('should build correct message', async () => {
            const result = await helper.sendIssueV1(addressInfo, 'MYTOKEN', 'Updated description')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'ISSUE|1|MYTOKEN|Updated description')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.issue, { id: 1 })
            assert.strictEqual(result.credit, undefined)
        })

        it('should only call waitForIssue, not waitForCredit', async () => {
            await helper.sendIssueV1(addressInfo, 'TOK', 'desc')
            assert(global.indexerDatabase.waitForIssue.calledOnce)
            assert(global.indexerDatabase.waitForCredit.notCalled)
        })
    })

    describe('sendIssueV2', () => {
        it('should build correct message with all params', async () => {
            const result = await helper.sendIssueV2(
                addressInfo, 'TOK', '100', '50', '25', '3', '200', '300', 'memo'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'ISSUE|2|TOK|100|50|25|3|200|300|memo')
            assert.strictEqual(result.txHash, 'abc123')
        })

        it('should replace null params with empty string', async () => {
            await helper.sendIssueV2(addressInfo, 'TOK', '100', '50', null, null, null, null, null)

            const msg = createTxStub.firstCall.args[1]
            // transferSupply, mintAddressMax, mintStartBlock, mintStopBlock, memo all null→""
            assert.strictEqual(msg, 'ISSUE|2|TOK|100|50|||||')
        })
    })

    describe('sendIssueV3', () => {
        it('should build correct message', async () => {
            await helper.sendIssueV3(
                addressInfo, 'TOK', '1', '1', '1', '1', '1', '1', '1', 'memo'
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'ISSUE|3|TOK|1|1|1|1|1|1|1|memo')
        })

        it('should replace null params with empty string', async () => {
            await helper.sendIssueV3(addressInfo, 'TOK', null, null, null, null, null, null, null, null)

            const msg = createTxStub.firstCall.args[1]
            // 8 optional params (lockMaxSupply..lockMintSupply + memo) all null→""
            assert.strictEqual(msg, 'ISSUE|3|TOK||||||||')
        })
    })

    describe('sendIssueV4', () => {
        it('should build correct message', async () => {
            await helper.sendIssueV4(addressInfo, 'TOK', '500', 'CBTOKEN', '10', 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'ISSUE|4|TOK|500|CBTOKEN|10|memo')
        })

        it('should replace null params with empty string', async () => {
            await helper.sendIssueV4(addressInfo, 'TOK', null, null, null, null)

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'ISSUE|4|TOK||||')
        })
    })

    describe('sendIssueV5', () => {
        it('should build correct message', async () => {
            await helper.sendIssueV5(addressInfo, 'TOK', 'allowList1', 'blockList1', 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'ISSUE|5|TOK|allowList1|blockList1|memo')
        })

        it('should replace null params with empty string', async () => {
            await helper.sendIssueV5(addressInfo, 'TOK', null, null, null)

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'ISSUE|5|TOK|||')
        })
    })
})
