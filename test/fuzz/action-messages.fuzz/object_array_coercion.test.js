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

        it('object field becomes "[object Object]" in BROADCAST V0', async function () {
            const broadcastHelper = require('../../helpers/broadcastHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await broadcastHelper.sendBroadcastV0(fakeAddr, { evil: true }, 100)

            assert(capturedMessage.includes('[object Object]'),
                'object should be coerced to "[object Object]" string via concatenation')
        })

        it('array field becomes comma-joined string in BROADCAST V0', async function () {
            const broadcastHelper = require('../../helpers/broadcastHelper')
            const fakeAddr = { address: 'addr', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

            await broadcastHelper.sendBroadcastV0(fakeAddr, [1, 2, 3], 100)

            assert(capturedMessage.includes('1,2,3'),
                'array should be coerced to comma-joined string via concatenation')
        })
    })
})
