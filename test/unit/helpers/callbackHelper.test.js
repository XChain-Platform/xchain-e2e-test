'use strict'

const sinon = require('sinon')
const assert = require('assert')
const transactionHelper = require('../../transactionHelper')
const helper = require('../../helpers/callbackHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('callbackHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForCallback: sinon.stub().resolves({ id: 100 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendCallbackV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendCallbackV0(addressInfo, 'MYTOKEN', 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'CALLBACK|0|MYTOKEN|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.callback, { id: 100 })
        })

        it('should call waitForCallback once with correct args', async () => {
            await helper.sendCallbackV0(addressInfo, 'TOK', '')
            assert(global.indexerDatabase.waitForCallback.calledOnce)
            const waitArg = global.indexerDatabase.waitForCallback.firstCall.args[0]
            assert.strictEqual(waitArg.tick, 'TOK')
            assert.strictEqual(waitArg.source, 'addr1')
        })
    })
})
