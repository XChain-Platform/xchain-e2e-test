'use strict'

const sinon = require('sinon')
const assert = require('assert')
const transactionHelper = require('../../transactionHelper')
const helper = require('../../helpers/dividendHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('dividendHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForDividend: sinon.stub().resolves({ id: 110 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendDividendV0', () => {
        it('should build correct message', async () => {
            const result = await helper.sendDividendV0(addressInfo, 'MYTOKEN', 'BTC', '1000', 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'DIVIDEND|0|MYTOKEN|BTC|1000|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.dividend, { id: 110 })
        })

        it('should call waitForDividend with correct args', async () => {
            await helper.sendDividendV0(addressInfo, 'TOK', 'DIVTOK', '500', '')
            assert(global.indexerDatabase.waitForDividend.calledOnce)
            const waitArg = global.indexerDatabase.waitForDividend.firstCall.args[0]
            assert.strictEqual(waitArg.tick, 'TOK')
            assert.strictEqual(waitArg.dividendTick, 'DIVTOK')
            assert.strictEqual(waitArg.amount, '500')
            assert.strictEqual(waitArg.source, 'addr1')
        })
    })
})
