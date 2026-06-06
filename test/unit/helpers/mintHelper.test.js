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
const helper = require('../../helpers/mintHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('mintHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForMint: sinon.stub().resolves({ id: 20 }),
            waitForCredit: sinon.stub().resolves({ id: 21 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendMintV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendMintV0(addressInfo, 'TOK', '100', 'dest1', 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'MINT|0|TOK|100|dest1|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.mint, { id: 20 })
            assert.deepStrictEqual(result.credit, { id: 21 })
        })

        it('should call waitForMint and waitForCredit', async () => {
            await helper.sendMintV0(addressInfo, 'TOK', '100', 'dest1', '')
            assert(global.indexerDatabase.waitForMint.calledOnce)
            assert(global.indexerDatabase.waitForCredit.calledOnce)
        })

        it('should pass addressInfo as first arg to createAndSendTransaction', async () => {
            await helper.sendMintV0(addressInfo, 'TOK', '500', 'addr1', '')
            assert.strictEqual(createTxStub.firstCall.args[0], addressInfo)
        })
    })
})
