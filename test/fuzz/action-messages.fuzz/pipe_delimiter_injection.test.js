'use strict'

// SPDX-License-Identifier: AGPL-3.0-or-later

const { assert, sinon, transactionHelper } = require('./support/environment')

describe('Fuzz: ACTION Message Construction', function () {
    describe('Pipe delimiter injection in ACTION fields', function () {

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

        it('tick containing pipe characters produces message with extra fields', async function () {
            const issueHelper = require('../../helpers/issueHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await issueHelper.sendIssueV1(fakeAddr, 'EVIL|TICK', 'description')

            assert(typeof capturedMessage === 'string')
            const pipeCount = (capturedMessage.match(/\|/g) || []).length
            assert(pipeCount > 3, `Pipe in tick should increase field count: got ${pipeCount} pipes`)
        })

        it('description containing pipes does not crash ISSUE V0', async function () {
            const issueHelper = require('../../helpers/issueHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await issueHelper.sendIssueV0(fakeAddr, 'TOKF', 1000, 100, 0, 'desc|with|pipes', 500)

            assert(typeof capturedMessage === 'string')
        })

        it('memo containing pipes does not crash SEND V0', async function () {
            const sendHelper = require('../../helpers/sendHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await sendHelper.sendSendV0(fakeAddr, 'TOKF', 100, 'dest', 'memo|with|pipes')

            assert(typeof capturedMessage === 'string')
        })
    })
})
