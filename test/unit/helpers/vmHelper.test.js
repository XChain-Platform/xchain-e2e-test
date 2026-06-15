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
const helper = require('../../helpers/vmHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('vmHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForContract: sinon.stub().resolves({ id: 210 }),
            waitForExecution: sinon.stub().resolves({ id: 211 }),
            waitForDeposit: sinon.stub().resolves({ id: 212 }),
            waitForWithdrawal: sinon.stub().resolves({ id: 213 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendDeployV0', () => {
        it('should base64-encode code and build correct message', async () => {
            const code = 'function main(){}'
            const codeB64 = Buffer.from(code, 'utf8').toString('base64')
            const result = await helper.sendDeployV0(addressInfo, code, '50000', 'param1,param2')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, `DEPLOY|0|${codeB64}|50000|param1,param2`)
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.contract, { id: 210 })
        })

        it('should omit constructorParams when not provided', async () => {
            const code = 'code'
            const codeB64 = Buffer.from(code, 'utf8').toString('base64')
            await helper.sendDeployV0(addressInfo, code, '10000')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, `DEPLOY|0|${codeB64}|10000`)
        })

        it('should pass P2SH as the encoding arg to createAndSendTransaction', async () => {
            await helper.sendDeployV0(addressInfo, 'x', '100')
            // signature: createAndSendTransaction(addressInfo, msg, null, [], 'P2SH')
            assert.strictEqual(createTxStub.firstCall.args[4], 'P2SH')
        })

        it('should call waitForContract once', async () => {
            await helper.sendDeployV0(addressInfo, 'code', '5000')
            assert(global.indexerDatabase.waitForContract.calledOnce)
        })
    })

    describe('sendExecuteV0', () => {
        it('should build correct message with params', async () => {
            const result = await helper.sendExecuteV0(addressInfo, '5', 'transfer', ['100', 'dest1'])

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'EXECUTE|0|5|transfer|100|dest1')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.execution, { id: 211 })
        })

        it('should build correct message without params', async () => {
            await helper.sendExecuteV0(addressInfo, '5', 'getBalance', [])

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'EXECUTE|0|5|getBalance')
        })

        it('should call waitForExecution once', async () => {
            await helper.sendExecuteV0(addressInfo, '1', 'method', [])
            assert(global.indexerDatabase.waitForExecution.calledOnce)
        })
    })

    describe('sendDepositV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendDepositV0(addressInfo, '3', 'TOK', '500')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'DEPOSIT|0|3|TOK|500')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.deposit, { id: 212 })
        })

        it('should call waitForDeposit with correct args', async () => {
            await helper.sendDepositV0(addressInfo, '3', 'TOK', '500')
            const waitArg = global.indexerDatabase.waitForDeposit.firstCall.args[0]
            assert.strictEqual(waitArg.contractIndex, '3')
            assert.strictEqual(waitArg.tick, 'TOK')
            assert.strictEqual(waitArg.amount, '500')
            assert.strictEqual(waitArg.source, 'addr1')
        })
    })

    describe('sendWithdrawV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendWithdrawV0(addressInfo, '3', 'TOK', '250')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'WITHDRAW|0|3|TOK|250')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.withdrawal, { id: 213 })
        })

        it('should call waitForWithdrawal with correct args', async () => {
            await helper.sendWithdrawV0(addressInfo, '4', 'MYTOKEN', '999')
            const waitArg = global.indexerDatabase.waitForWithdrawal.firstCall.args[0]
            assert.strictEqual(waitArg.contractIndex, '4')
            assert.strictEqual(waitArg.tick, 'MYTOKEN')
            assert.strictEqual(waitArg.amount, '999')
        })
    })
})
