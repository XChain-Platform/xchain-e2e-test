'use strict'

const sinon = require('sinon')
const assert = require('assert')
const transactionHelper = require('../../transactionHelper')
const helper = require('../../helpers/sweepHelper')

const addressInfo = { address: 'addr1', privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) }

describe('sweepHelper', () => {
    let createTxStub

    beforeEach(() => {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('abc123')
        global.indexerDatabase = {
            waitForSweep: sinon.stub().resolves({ id: 90 }),
        }
    })

    afterEach(() => sinon.restore())

    describe('sendSweepV0', () => {
        it('should build correct message with explicit values', async () => {
            const result = await helper.sendSweepV0(addressInfo, 'dest1', 1, 1, 0, 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SWEEP|0|dest1|1|1|0|memo')
            assert.strictEqual(result.txHash, 'abc123')
            assert.deepStrictEqual(result.sweep, { id: 90 })
        })

        it('should default null balances to 1, ownerships to 1, escrows to 0', async () => {
            await helper.sendSweepV0(addressInfo, 'dest1', null, null, null, 'memo')

            const msg = createTxStub.firstCall.args[1]
            assert.strictEqual(msg, 'SWEEP|0|dest1|1|1|0|memo')
        })

        it('should call waitForSweep once', async () => {
            await helper.sendSweepV0(addressInfo, 'dest1', 1, 1, 0, '')
            assert(global.indexerDatabase.waitForSweep.calledOnce)
        })

        it('should pass source address to waitForSweep', async () => {
            await helper.sendSweepV0(addressInfo, 'dest1', 1, 0, 0, '')
            const waitArg = global.indexerDatabase.waitForSweep.firstCall.args[0]
            assert.strictEqual(waitArg.source, 'addr1')
            assert.strictEqual(waitArg.destination, 'dest1')
        })
    })
})
