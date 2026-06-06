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
const helper = require('../../helpers/fileHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('fileHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForFile: sinon.stub().resolves({ id: 70 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendFileV0', () => {
        it('should build correct message and pass rawData as third arg', async () => {
            const rawData = Buffer.from('file contents')
            const result = await helper.sendFileV0(
                addressInfo, 'myfile.txt', 'text/plain', 'My File', 'note', rawData
            )

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'FILE|0|myfile.txt|text/plain|My File|note')
            assert.strictEqual(createTxStub.firstCall.args[2], rawData)
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.file, { id: 70 })
        })

        it('should call waitForFile once', async () => {
            await helper.sendFileV0(addressInfo, 'f.jpg', 'image/jpeg', 'title', '', null)
            assert(global.indexerDatabase.waitForFile.calledOnce)
        })

        it('should pass source address to waitForFile', async () => {
            await helper.sendFileV0(addressInfo, 'f.txt', 'text/plain', 'title', '', null)
            const waitArg = global.indexerDatabase.waitForFile.firstCall.args[0]
            assert.strictEqual(waitArg.source, 'addr1')
        })
    })
})
