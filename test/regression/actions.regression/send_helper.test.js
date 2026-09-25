const assert = require('assert')
const sinon  = require('sinon')

const { transactionHelper, sendHelper } = require('./support/environment')

void describe('sendHelper', function () {

    let createTxStub

    beforeEach(function () {
        createTxStub = sinon.stub(transactionHelper, 'createAndSendTransaction').resolves('txhash-test')

        global.indexerDatabase.waitForIssue  = sinon.stub().resolves({ tick: 'TOKR', status: 'valid' })
        global.indexerDatabase.waitForSend   = sinon.stub().resolves({ tick: 'TOKR', status: 'valid' })
        global.indexerDatabase.waitForCredit = sinon.stub().resolves({ tick: 'TOKR', amount: '100' })
        global.indexerDatabase.waitForDebit  = sinon.stub().resolves({ tick: 'TOKR', amount: '100' })
        global.indexerDatabase.waitForMint   = sinon.stub().resolves({ tick: 'TOKR', status: 'valid' })
    })

    afterEach(function () {
        sinon.restore()
    })

    const fakeAddr = { address: 'addr1', privateKey: Buffer.alloc(32, 1), publicKey: Buffer.alloc(33, 2) }

    it('[regression:p1] R-ACT-002: sendSendV0 constructs correct pipe-delimited message', async function () {
        await sendHelper.sendSendV0(fakeAddr, 'TOKR', '100', 'dest1', 'memo1')

        assert.ok(createTxStub.calledOnce)
        const message = createTxStub.firstCall.args[1]
        assert.strictEqual(message, 'SEND|0|TOKR|100|dest1|memo1')
    })

    it('[regression:p1] R-ACT-002b: sendSendV0 calls waitForSend, waitForCredit, waitForDebit', async function () {
        await sendHelper.sendSendV0(fakeAddr, 'TOKR', '100', 'dest1', 'memo1')

        assert.ok(global.indexerDatabase.waitForSend.calledOnce)
        assert.ok(global.indexerDatabase.waitForCredit.calledOnce)
        assert.ok(global.indexerDatabase.waitForDebit.calledOnce)

        const creditFilter = global.indexerDatabase.waitForCredit.firstCall.args[0]
        assert.strictEqual(creditFilter.address, 'dest1')

        const debitFilter = global.indexerDatabase.waitForDebit.firstCall.args[0]
        assert.strictEqual(debitFilter.address, 'addr1')
    })

    it('[regression:p1] R-ACT-002c: sendSendV0 returns txHash, send, credit, debit', async function () {
        const result = await sendHelper.sendSendV0(fakeAddr, 'TOKR', '100', 'dest1', '')

        assert.strictEqual(result.txHash, 'txhash-test')
        assert.ok(result.send)
        assert.ok(result.credit)
        assert.ok(result.debit)
    })

    it('[regression:p1] R-ACT-006: sendSendV1 calls waitForSend twice for two destinations', async function () {
        await sendHelper.sendSendV1(fakeAddr, 'TOKR', '50', 'dest1', '30', 'dest2', 'memo')

        assert.strictEqual(global.indexerDatabase.waitForSend.callCount, 2)
        assert.strictEqual(global.indexerDatabase.waitForCredit.callCount, 2)
    })
})
