'use strict'

// SPDX-License-Identifier: AGPL-3.0-or-later

const { assert, sinon, transactionHelper } = require('./support/environment')

describe('Fuzz: ACTION Message Construction', function () {
    describe('Null/undefined field coercion', function () {

        let capturedMessage = null
        let createAndSendStub

        beforeEach(function () {
            capturedMessage = null
            createAndSendStub = sinon.stub(transactionHelper, 'createAndSendTransaction')
                .callsFake(async (addressInfo, data) => {
                    capturedMessage = data
                    return 'txhash-fuzz'
                })
        })

        afterEach(function () {
            sinon.restore()
        })

        it('null tick becomes "null" string literal in ISSUE V1', async function () {
            const issueHelper = require('../../helpers/issueHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await issueHelper.sendIssueV1(fakeAddr, null, 'desc')

            assert(capturedMessage.includes('null'),
                'null should be coerced to "null" string via concatenation')
        })

        it('undefined amount becomes "undefined" string literal in SEND V0', async function () {
            const sendHelper = require('../../helpers/sendHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await sendHelper.sendSendV0(fakeAddr, 'TOKF', undefined, 'dest', 'memo')

            assert(capturedMessage.includes('undefined'),
                'undefined should be coerced to "undefined" string via concatenation')
        })

        it('NaN amount becomes "NaN" string literal in MINT V0', async function () {
            const mintHelper = require('../../helpers/mintHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await mintHelper.sendMintV0(fakeAddr, 'TOKF', NaN, 'dest', 'memo')

            assert(capturedMessage.includes('NaN'),
                'NaN should be coerced to "NaN" string via concatenation')
        })
    })
})
